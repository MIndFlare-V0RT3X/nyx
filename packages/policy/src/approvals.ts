// SPDX-License-Identifier: AGPL-3.0-or-later
// Approval lifecycle over better-sqlite3. Approvals are single-use, expire
// by TTL, and bind to the exact action digest they were requested for.
// Every state change writes an audit row in the same transaction.

import { nanoid } from "nanoid";
import { appendAudit, ensureAuditTable, verifyAuditChain } from "./audit.js";
import { appendEventAudit } from "./event-audit.js";
import { CodedError } from "./errors.js";
import type {
  ApprovalContext,
  ApprovalEngine,
  ApprovalRecord,
  PolicyVerdict,
  RiskTier,
  SessionEvent,
} from "@nyx/protocol";
import Database from "better-sqlite3";

// ── 2.1.1: channel-facing approval presentation ──

/** An approval request as handed to a presenter (channel surface). */
export interface ApprovalRequest {
  approval_id: string;
  session_id: string;
  turn_id: string;
  summary: string;
  risk: RiskTier;
  action_digest: string;
  /** Epoch ms — the engine auto-denies at this point. */
  expires_at: number;
}

/**
 * A channel's way of SHOWING an approval request and collecting the
 * operator's decision. The engine calls present(); the operator responds by
 * calling engine.resolve(approval_id, decision, actor). withdraw() is called
 * when the request dies without a decision (expiry, abort, session close) so
 * the surface can clean up its UI.
 */
export interface ApprovalPresenter {
  readonly id: string;
  present(req: ApprovalRequest): Promise<void>;
  /** Engine calls this to withdraw a pending request (abort, session close, expiry cleanup). */
  withdraw(approval_id: string, reason: string): Promise<void>;
}

export interface RegisterPresenterOptions {
  /** TTL for approvals of this session (channel default 5 min). */
  ttl_ms?: number;
}

/** Default channel approval TTL (5 minutes; TTY default stays 10). */
export const DEFAULT_CHANNEL_APPROVAL_TTL_MS = 300_000;

export interface ApprovalEngineOptions {
  now?: () => number;
  /** Approval TTL in ms (default 10 minutes). */
  ttl_ms?: number;
  /** Poll interval for request() in ms (default 150). */
  poll_ms?: number;
  /**
   * Fired post-commit when a pending approval row is created. Surfaces use
   * this to append the `approval.requested` session event (the engine has no
   * route to the event log itself). Must not throw.
   */
  onCreated?: (record: ApprovalRecord) => void;
  /**
   * Fired post-commit when an approval reaches a final decision — resolved
   * by an operator or auto-denied by expiry. Surfaces append the
   * `approval.resolved` session event. Must not throw.
   */
  onResolved?: (record: ApprovalRecord) => void;
}

interface ApprovalRow {
  id: string;
  session_id: string;
  turn_id: string;
  action_digest: string;
  summary: string;
  risk: string;
  decision: string;
  decided_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

const APPROVALS_DDL = `CREATE TABLE IF NOT EXISTS policy_approvals (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  action_digest TEXT NOT NULL, summary TEXT NOT NULL, risk TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending', decided_by TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
)`;

/**
 * 2.0.1: create the approval engine's tables on any handle (shared or
 * dedicated). The engine table is named `policy_approvals` because the
 * unified nyx.db already has a session-store PROJECTION table named
 * `approvals` (rebuildable from events, different row space) — one name,
 * one owner.
 */
export function ensureApprovalEngineTables(db: Database.Database): void {
  db.exec(APPROVALS_DDL);
  ensureAuditTable(db);
}

/**
 * 2.0.1: a dedicated policy.db from the split-DB era names its engine table
 * `approvals`. On a file that has no session-store tables (no `events`
 * table), that table is unambiguously the engine's — rename it in place. On
 * the unified nyx.db the `approvals` table is the session-store projection
 * and is never touched.
 */
function renameLegacyApprovalsTable(db: Database.Database): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  const names = new Set(tables.map((t) => t.name));
  if (names.has("events")) return; // session-store db: `approvals` is the projection
  if (!names.has("approvals")) return; // nothing to rename
  if (names.has("policy_approvals")) return; // already migrated
  db.exec("ALTER TABLE approvals RENAME TO policy_approvals");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * PolicyVerdict (frozen protocol) carries no risk field, but the approvals
 * table and the approval.requested event need one. The policy engine's
 * summary convention `"<tool>" on <sketch> [risk RX]` is the only risk signal
 * on the verdict, so we recover it from there. Verdicts produced without the
 * convention default to R3 (conservative: noteworthy enough to surface).
 */
function riskFromVerdict(v: PolicyVerdict): RiskTier {
  const m = /\[risk R([0-4])\]/.exec(v.summary);
  return m ? (`R${m[1]}` as RiskTier) : "R3";
}

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    action_digest: row.action_digest,
    summary: row.summary,
    risk: row.risk as RiskTier,
    decision: row.decision as ApprovalRecord["decision"],
    decided_by: row.decided_by,
    created_at: row.created_at,
    expires_at: row.expires_at,
    used_at: row.used_at,
  };
}

export class ApprovalEngineImpl implements ApprovalEngine {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly pollMs: number;
  private readonly onCreated: ((record: ApprovalRecord) => void) | undefined;
  private readonly onResolved: ((record: ApprovalRecord) => void) | undefined;
  /** 2.1.1: per-session presenters (channel surfaces); absent → TTY/poll path. */
  private readonly presenters = new Map<string, { presenter: ApprovalPresenter; ttlMs: number }>();

  constructor(db: Database.Database, opts: ApprovalEngineOptions = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttl_ms ?? 600_000;
    this.pollMs = opts.poll_ms ?? 150;
    this.onCreated = opts.onCreated;
    this.onResolved = opts.onResolved;
    // Idempotent: works against any db handle, including a fresh one.
    ensureApprovalEngineTables(db);
  }

  /**
   * 2.1.1: register a presenter for a session. While registered, request()
   * delegates to it instead of relying on the TTY loop: the presenter shows
   * the request, the operator answers, the presenter (or the resolve route)
   * calls engine.resolve(). The channel TTL applies (default 5 min).
   */
  registerPresenter(
    session_id: string,
    presenter: ApprovalPresenter,
    opts: RegisterPresenterOptions = {},
  ): void {
    this.presenters.set(session_id, {
      presenter,
      ttlMs: opts.ttl_ms ?? DEFAULT_CHANNEL_APPROVAL_TTL_MS,
    });
  }

  /**
   * 2.1.1: drop a session's presenter. Pending approvals of the session are
   * denied and withdrawn first (a closed surface must not leave orphans).
   */
  unregisterPresenter(session_id: string): void {
    if (!this.presenters.has(session_id)) return;
    // Withdraw FIRST, while the presenter is still registered: the surface
    // must receive its withdraw() notifications for every pending request.
    this.withdrawSession(session_id, "presenter unregistered");
    this.presenters.delete(session_id);
  }

  /** Sessions with a registered presenter (surface teardown). */
  presenterSessions(): string[] {
    return [...this.presenters.keys()];
  }

  /**
   * Phase 3: the presenter registered for a session, if any (with its TTL).
   * Surfaces use this to COPY a parent session's presenter onto its
   * subagent children, so an "ask" inside a child turn is presented on the
   * originating channel instead of dying on the TTL.
   */
  presenterFor(session_id: string): { presenter: ApprovalPresenter; ttl_ms: number } | undefined {
    const entry = this.presenters.get(session_id);
    return entry === undefined ? undefined : { presenter: entry.presenter, ttl_ms: entry.ttlMs };
  }

  /** Insert a pending approval (plus its audit row) and block until it is resolved or expired. */
  async request(v: PolicyVerdict, ctx: ApprovalContext): Promise<"allow" | "deny"> {
    const id = nanoid();
    const createdAt = this.now();
    const presenterEntry = this.presenters.get(ctx.session_id);
    const ttl = presenterEntry?.ttlMs ?? this.ttlMs;
    const expiresAt = createdAt + ttl;
    const risk = riskFromVerdict(v);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO policy_approvals
             (id, session_id, turn_id, action_digest, summary, risk, decision, decided_by, created_at, expires_at, used_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
        )
        .run(
          id,
          ctx.session_id,
          ctx.turn_id,
          v.action_digest,
          v.summary,
          risk,
          createdAt,
          expiresAt,
        );
      appendAudit(this.db, {
        actor: ctx.actor_id,
        action: "approval.requested",
        payload: {
          approval_id: id,
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          action_digest: v.action_digest,
          summary: v.summary,
          risk,
          expires_at: expiresAt,
        },
      });
    })();
    this.onCreated?.({
      id,
      session_id: ctx.session_id,
      turn_id: ctx.turn_id,
      action_digest: v.action_digest,
      summary: v.summary,
      risk,
      decision: "pending",
      decided_by: null,
      created_at: createdAt,
      expires_at: expiresAt,
      used_at: null,
    });

    // 2.1.1: a registered presenter SHOWS the request (inline keyboard,
    // approval_required body, …). present() failing must not break the turn:
    // the approval stays pending until resolved or the TTL auto-denies.
    if (presenterEntry !== undefined) {
      try {
        await presenterEntry.presenter.present({
          approval_id: id,
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          summary: v.summary,
          risk,
          action_digest: v.action_digest,
          expires_at: expiresAt,
        });
      } catch {
        // surfaced by the presenter's own logging; the poll loop below is the
        // safety net (TTL auto-deny + withdraw)
      }
    }

    for (;;) {
      await sleep(this.pollMs);
      const row = this.db
        .prepare("SELECT decision, expires_at FROM policy_approvals WHERE id = ?")
        .get(id) as Pick<ApprovalRow, "decision" | "expires_at"> | undefined;
      if (row && row.decision !== "pending") return row.decision as "allow" | "deny";
      if (this.now() >= expiresAt) {
        this.db.transaction(() => {
          this.db
            .prepare(
              "UPDATE policy_approvals SET decision = 'deny', decided_by = 'system:expiry' WHERE id = ? AND decision = 'pending'",
            )
            .run(id);
          appendAudit(this.db, {
            actor: "system:expiry",
            action: "approval.expired",
            payload: {
              approval_id: id,
              session_id: ctx.session_id,
              action_digest: v.action_digest,
            },
          });
        })();
        this.onResolved?.({
          id,
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          action_digest: v.action_digest,
          summary: v.summary,
          risk,
          decision: "deny",
          decided_by: "system:expiry",
          created_at: createdAt,
          expires_at: expiresAt,
          used_at: null,
        });
        // 2.1.1: the presenter learns its request died without a decision
        // ("⏱ approval expired — action denied" on channels).
        if (presenterEntry !== undefined) {
          try {
            await presenterEntry.presenter.withdraw(id, "expired");
          } catch {
            // presenter cleanup is best-effort
          }
        }
        return "deny";
      }
      if (!row) return "deny"; // row vanished externally — nothing left to poll for
    }
  }

  async resolve(
    id: string,
    decision: "allow" | "deny",
    decidedBy: string,
  ): Promise<ApprovalRecord> {
    const updated = this.db.transaction((): ApprovalRecord => {
      const row = this.getRow(id);
      if (!row) throw new CodedError("approval_denied", `approval ${id} not found`);
      if (row.decision !== "pending") {
        throw new CodedError(
          "approval_denied",
          `approval ${id} already resolved (${row.decision})`,
        );
      }
      if (this.now() >= row.expires_at) {
        throw new CodedError("approval_expired", `approval ${id} expired`);
      }
      this.db
        .prepare("UPDATE policy_approvals SET decision = ?, decided_by = ? WHERE id = ?")
        .run(decision, decidedBy, id);
      // Same transaction as the update: commits or rolls back together.
      appendAudit(this.db, {
        actor: decidedBy,
        action: "approval.resolved",
        payload: {
          approval_id: id,
          decision,
          session_id: row.session_id,
          action_digest: row.action_digest,
        },
      });
      const updated = this.getRow(id);
      if (!updated)
        throw new CodedError("approval_denied", `approval ${id} disappeared mid-transaction`);
      return toRecord(updated);
    })();
    this.onResolved?.(updated);
    return updated;
  }

  async consume(id: string, actionDigest: string): Promise<ApprovalRecord> {
    return this.db.transaction((): ApprovalRecord => {
      const row = this.getRow(id);
      if (!row) throw new CodedError("approval_denied", `approval ${id} not found`);
      if (row.decision !== "allow") {
        throw new CodedError("approval_denied", `approval ${id} is ${row.decision}, not allow`);
      }
      if (this.now() >= row.expires_at) {
        throw new CodedError("approval_expired", `approval ${id} expired`);
      }
      if (row.used_at !== null) {
        throw new CodedError("approval_denied", `approval ${id} already consumed`);
      }
      if (row.action_digest !== actionDigest) {
        throw new CodedError("approval_denied", "digest mismatch");
      }
      const usedAt = this.now();
      this.db.prepare("UPDATE policy_approvals SET used_at = ? WHERE id = ?").run(usedAt, id);
      appendAudit(this.db, {
        actor: "system:policy",
        action: "approval.consumed",
        payload: { approval_id: id, action_digest: actionDigest, session_id: row.session_id },
      });
      const updated = this.getRow(id);
      if (!updated)
        throw new CodedError("approval_denied", `approval ${id} disappeared mid-transaction`);
      return toRecord(updated);
    })();
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    const row = this.getRow(id);
    return row ? toRecord(row) : null;
  }

  async pending(sessionId: string): Promise<ApprovalRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM policy_approvals
          WHERE session_id = ? AND decision = 'pending' AND expires_at > ?
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(sessionId, this.now()) as ApprovalRow[];
    return rows.map(toRecord);
  }

  /**
   * 2.0.2: withdraw every pending approval of a session — used by the
   * per-session abort route (DELETE /v1/sessions/:id/turns) and by session
   * teardown. Each withdrawn approval is resolved deny (decided_by
   * "system:withdrawn") with its audit row in the same transaction, so an
   * aborted turn never leaves an orphaned pending request behind (and a
   * blocked request() returns instead of waiting out its TTL).
   */
  withdrawSession(sessionId: string, reason: string): number {
    const presenterEntry = this.presenters.get(sessionId);
    const pendings = this.db
      .prepare(
        `SELECT * FROM policy_approvals
          WHERE session_id = ? AND decision = 'pending' AND expires_at > ?`,
      )
      .all(sessionId, this.now()) as ApprovalRow[];
    let withdrawn = 0;
    for (const row of pendings) {
      const updated = this.db.transaction((): ApprovalRecord => {
        this.db
          .prepare(
            "UPDATE policy_approvals SET decision = 'deny', decided_by = 'system:withdrawn' WHERE id = ? AND decision = 'pending'",
          )
          .run(row.id);
        appendAudit(this.db, {
          actor: "system:withdrawn",
          action: "approval.withdrawn",
          payload: {
            approval_id: row.id,
            session_id: row.session_id,
            action_digest: row.action_digest,
            reason,
          },
        });
        const after = this.getRow(row.id);
        if (!after)
          throw new CodedError("approval_denied", `approval ${row.id} disappeared mid-transaction`);
        return toRecord(after);
      })();
      withdrawn += 1;
      this.onResolved?.(updated);
      // 2.1.1: the surface learns its request died without a decision.
      if (presenterEntry !== undefined) {
        presenterEntry.presenter.withdraw(row.id, reason).catch(() => undefined);
      }
    }
    return withdrawn;
  }

  private getRow(id: string): ApprovalRow | undefined {
    return this.db.prepare("SELECT * FROM policy_approvals WHERE id = ?").get(id) as
      ApprovalRow | undefined;
  }
}

/**
 * Opens the approval engine's SQLite storage — either a dedicated file path
 * (":memory:" works; legacy `approvals` tables are renamed in place) or an
 * already-open handle (the 2.0.1 unified nyx.db; the handle is never closed
 * by the engine — the provider owns it). Surfaces use this so no package
 * outside @nyx/policy needs a better-sqlite3 dependency just to construct
 * the engine.
 *
 * The hash chain is verified on load: tamper-evidence only means something if
 * verification actually runs, so every surface that opens the persistent
 * approval/audit store (`nyx run`, `nyx chat`, `nyx approvals`, the server)
 * checks the chain up front and refuses to operate on a log that fails
 * verification.
 *
 * `auditEvent` exposes the tool-event audit path on the same db handle: the
 * session store's in-transaction commit hook calls it (2.0.1), landing
 * tool.call / tool.result / tool.error / action.denied rows in the same hash
 * chain as approval decisions (see event-audit.ts).
 */
export interface OpenedApprovalEngine {
  engine: ApprovalEngineImpl;
  close(): void;
  /** Hash-chain audit row for one stored session event (no-op for non-audited types). */
  auditEvent(event: SessionEvent, seq: number): void;
  /** General hash-chain audit row (channel identity decisions, surface events). */
  audit(entry: { actor: string; action: string; payload: unknown }): void;
}

export function openApprovalEngine(
  dbOrPath: string | Database.Database,
  opts: ApprovalEngineOptions = {},
): OpenedApprovalEngine {
  const shared = typeof dbOrPath !== "string";
  const db = shared ? dbOrPath : new Database(dbOrPath);
  try {
    if (!shared) renameLegacyApprovalsTable(db);
    const engine = new ApprovalEngineImpl(db, opts);
    const verification = verifyAuditChain(db);
    if (!verification.ok) {
      throw new CodedError(
        "validation_failed",
        `audit chain verification failed at row ${verification.first_bad_id ?? "?"} ` +
          `(${verification.checked} rows verified) in ${shared ? "the unified database" : dbOrPath}: ` +
          "the audit log may have been tampered with",
      );
    }
    return {
      engine,
      // A shared handle is closed by its provider (the unified-db opener),
      // never by the engine.
      close: () => {
        if (!shared) db.close();
      },
      auditEvent: (event, seq) => appendEventAudit(db, event, seq),
      audit: (entry) => appendAudit(db, entry),
    };
  } catch (err) {
    if (!shared) db.close();
    throw err;
  }
}
