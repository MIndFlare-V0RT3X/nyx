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

const APPROVALS_DDL = `CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  action_digest TEXT NOT NULL, summary TEXT NOT NULL, risk TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending', decided_by TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
)`;

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

  constructor(db: Database.Database, opts: ApprovalEngineOptions = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttl_ms ?? 600_000;
    this.pollMs = opts.poll_ms ?? 150;
    this.onCreated = opts.onCreated;
    this.onResolved = opts.onResolved;
    // Idempotent: works against any db handle, including a fresh one.
    db.exec(APPROVALS_DDL);
    ensureAuditTable(db);
  }

  /** Insert a pending approval (plus its audit row) and block until it is resolved or expired. */
  async request(v: PolicyVerdict, ctx: ApprovalContext): Promise<"allow" | "deny"> {
    const id = nanoid();
    const createdAt = this.now();
    const expiresAt = createdAt + this.ttlMs;
    const risk = riskFromVerdict(v);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO approvals
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

    for (;;) {
      await sleep(this.pollMs);
      const row = this.db
        .prepare("SELECT decision, expires_at FROM approvals WHERE id = ?")
        .get(id) as Pick<ApprovalRow, "decision" | "expires_at"> | undefined;
      if (row && row.decision !== "pending") return row.decision as "allow" | "deny";
      if (this.now() >= expiresAt) {
        this.db.transaction(() => {
          this.db
            .prepare(
              "UPDATE approvals SET decision = 'deny', decided_by = 'system:expiry' WHERE id = ? AND decision = 'pending'",
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
        .prepare("UPDATE approvals SET decision = ?, decided_by = ? WHERE id = ?")
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
      this.db.prepare("UPDATE approvals SET used_at = ? WHERE id = ?").run(usedAt, id);
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
        `SELECT * FROM approvals
          WHERE session_id = ? AND decision = 'pending' AND expires_at > ?
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(sessionId, this.now()) as ApprovalRow[];
    return rows.map(toRecord);
  }

  private getRow(id: string): ApprovalRow | undefined {
    return this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      ApprovalRow | undefined;
  }
}

/**
 * Opens a dedicated SQLite file (or ":memory:") for the approval engine and
 * audit chain. Surfaces use this so no package outside @nyx/policy needs a
 * better-sqlite3 dependency just to construct the engine.
 *
 * The hash chain is verified on load: tamper-evidence only means something if
 * verification actually runs, so every surface that opens the persistent
 * approval/audit store (`nyx run`, `nyx chat`, `nyx approvals`, the server)
 * checks the chain up front and refuses to operate on a log that fails
 * verification.
 *
 * `auditEvent` exposes the tool-event audit path on the same db handle: the
 * app-layer EventSink calls it after the session store assigns an event's
 * seq, landing tool.call / tool.result / tool.error / action.denied rows in
 * the same hash chain (see event-audit.ts).
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
  dbPath: string,
  opts: ApprovalEngineOptions = {},
): OpenedApprovalEngine {
  const db = new Database(dbPath);
  try {
    const engine = new ApprovalEngineImpl(db, opts);
    const verification = verifyAuditChain(db);
    if (!verification.ok) {
      throw new CodedError(
        "validation_failed",
        `audit chain verification failed at row ${verification.first_bad_id ?? "?"} ` +
          `(${verification.checked} rows verified) in ${dbPath}: ` +
          "the audit log may have been tampered with",
      );
    }
    return {
      engine,
      close: () => db.close(),
      auditEvent: (event, seq) => appendEventAudit(db, event, seq),
      audit: (entry) => appendAudit(db, entry),
    };
  } catch (err) {
    db.close();
    throw err;
  }
}
