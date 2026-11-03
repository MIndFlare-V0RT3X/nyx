// SPDX-License-Identifier: AGPL-3.0-or-later
// The session store: an append-only SQLite event log plus rebuildable
// projections, implementing @nyx/protocol's SessionStore contract.

import Database from "better-sqlite3";
import { eq, desc } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { nanoid } from "nanoid";
import { canonicalJson, mergeUsage, SessionEventSchema, StoredEventSchema } from "@nyx/protocol";
import type {
  ApprovalRecord,
  ContentBlock,
  Engagement,
  Message,
  Projection,
  RiskTier,
  SessionEvent,
  SessionMeta,
  SessionStore,
  StoredEvent,
  ToolCallRecord,
  Usage,
} from "@nyx/protocol";
import { migrate } from "./migrate.js";
import {
  applyProjectionEvent,
  prepareProjectionStatements,
  type ProjectionStatements,
} from "./projections.js";
import * as schema from "./schema.js";

/** stream() polls for new events at this interval (ms). */
const STREAM_POLL_MS = 25;
/** list() default page size. */
const LIST_DEFAULT_LIMIT = 50;

export type SessionStoreErrorCode = "not_found" | "validation_failed" | "closed";

/** Typed error for outcomes a caller must distinguish. */
export class SessionStoreError extends Error {
  readonly code: SessionStoreErrorCode;

  constructor(code: SessionStoreErrorCode, message: string) {
    super(message);
    this.name = "SessionStoreError";
    this.code = code;
  }
}

/** The better-sqlite3 handle instance type. */
type SqliteDatabase = Database.Database;

type SqliteStatement = Database.Statement<unknown[], unknown>;

export interface SessionStoreOptions {
  /**
   * Reuse an existing better-sqlite3 handle (e.g. to share one database with
   * @nyx/policy). Migrations still run, idempotently. The handle is NOT
   * closed by close() — the provider owns it.
   */
  db?: SqliteDatabase;
  /**
   * Debug mode: validate events against the protocol Zod schemas on append
   * and read. Off by default — validation never runs on the hot path.
   */
  validate?: boolean;
}

interface SessionRow {
  id: string;
  parent_id: string | null;
  owner_id: string;
  persona_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  engagement_json: string | null;
  metadata_json: string | null;
}

interface EventRow {
  seq: number;
  payload_json: string;
  type: string;
  ts: number;
}

interface LastSeqRow {
  last_seq: number;
}

interface UsageEventRow {
  payload_json: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class SessionStoreImpl implements SessionStore {
  /** The underlying better-sqlite3 handle (shared-DB access for other packages). */
  readonly db: SqliteDatabase;
  private readonly dz: BetterSQLite3Database;
  private readonly ownsDb: boolean;
  private readonly validate: boolean;
  private readonly projectionStmts: ProjectionStatements;
  private readonly stmts: {
    insertEvent: SqliteStatement;
    readEvents: SqliteStatement;
    readEventsUpTo: SqliteStatement;
    eventsPage: SqliteStatement;
    usageEvents: SqliteStatement;
    selectSession: SqliteStatement;
    selectLastSeq: SqliteStatement;
    touchSession: SqliteStatement;
  };
  private closed = false;

  constructor(path: string, opts: SessionStoreOptions = {}) {
    this.ownsDb = opts.db === undefined;
    this.db = opts.db ?? new Database(path);
    // Pragmas are idempotent; WAL is a no-op (returns "memory") for :memory:.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    migrate(this.db);
    this.dz = drizzle(this.db);
    this.validate = opts.validate ?? false;
    this.projectionStmts = prepareProjectionStatements(this.db);
    this.stmts = {
      // Hot path: raw prepared statements. payload_json is the canonical JSON
      // of the whole event (type included) minus seq, so reads and replays
      // reproduce byte-identical values.
      insertEvent: this.db.prepare(
        "INSERT INTO events (session_id, type, payload_json, ts) VALUES (?, ?, ?, ?)",
      ),
      readEvents: this.db.prepare(
        "SELECT seq, type, payload_json, ts FROM events WHERE session_id = ? AND seq >= ? ORDER BY seq LIMIT ?",
      ),
      readEventsUpTo: this.db.prepare(
        "SELECT seq, type, payload_json, ts FROM events WHERE session_id = ? AND seq <= ? ORDER BY seq",
      ),
      // Paged replay: better-sqlite3 forbids running other statements while
      // an .iterate() cursor is open, so rebuild reads in seq-ordered pages.
      eventsPage: this.db.prepare(
        "SELECT seq, payload_json FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
      ),
      usageEvents: this.db.prepare(
        "SELECT payload_json FROM events WHERE session_id = ? AND type = 'turn.completed' ORDER BY seq",
      ),
      selectSession: this.db.prepare(
        "SELECT id, parent_id, owner_id, persona_id, title, created_at, updated_at, engagement_json, metadata_json FROM sessions WHERE id = ?",
      ),
      selectLastSeq: this.db.prepare("SELECT last_seq FROM projection_version WHERE name = ?"),
      touchSession: this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?"),
    };
  }

  async create(input: {
    owner_id: string;
    persona_id: string;
    title?: string;
    parent_id?: string;
    engagement?: Engagement | null;
  }): Promise<SessionMeta> {
    this.assertOpen();
    if (typeof input.owner_id !== "string" || input.owner_id.length === 0) {
      throw new SessionStoreError(
        "validation_failed",
        "create: owner_id must be a non-empty string",
      );
    }
    if (typeof input.persona_id !== "string" || input.persona_id.length === 0) {
      throw new SessionStoreError(
        "validation_failed",
        "create: persona_id must be a non-empty string",
      );
    }
    if (input.title !== undefined && typeof input.title !== "string") {
      throw new SessionStoreError("validation_failed", "create: title must be a string");
    }
    if (
      input.engagement !== null &&
      input.engagement !== undefined &&
      typeof input.engagement !== "object"
    ) {
      throw new SessionStoreError(
        "validation_failed",
        "create: engagement must be an object or null",
      );
    }
    const id = nanoid();
    const now = Date.now();
    const parentId = input.parent_id ?? null;
    const engagement = input.engagement ?? null;
    const event: SessionEvent = {
      type: "session.created",
      session_id: id,
      owner_id: input.owner_id,
      persona_id: input.persona_id,
      parent_id: parentId,
      engagement,
      ts: now,
    };
    if (this.validate) this.debugValidateEvent(event);
    const txn = this.db.transaction((): SessionMeta => {
      this.dz
        .insert(schema.sessions)
        .values({
          id,
          parentId,
          ownerId: input.owner_id,
          personaId: input.persona_id,
          title: input.title ?? "",
          createdAt: now,
          updatedAt: now,
          engagementJson: engagement === null ? null : canonicalJson(engagement),
          metadataJson: null,
        })
        .run();
      this.insertEvents(id, [event], now);
      return this.rowToMeta(this.requireSessionRow(id));
    });
    return txn();
  }

  async append(session_id: string, events: SessionEvent[]): Promise<StoredEvent[]> {
    this.assertOpen();
    this.requireSessionRow(session_id);
    for (const ev of events) {
      if (ev.session_id !== session_id) {
        throw new SessionStoreError(
          "validation_failed",
          `append: event session_id ${JSON.stringify(ev.session_id)} does not match ${JSON.stringify(session_id)}`,
        );
      }
      if (this.validate) this.debugValidateEvent(ev);
    }
    const now = Date.now();
    const txn = this.db.transaction(() => this.insertEvents(session_id, events, now));
    return txn();
  }

  async read(session_id: string, from_seq = 0, limit?: number): Promise<StoredEvent[]> {
    this.assertOpen();
    this.requireSessionRow(session_id);
    const rows = this.stmts.readEvents.all(session_id, from_seq, limit ?? -1) as EventRow[];
    return rows.map((row) => this.rowToStored(row));
  }

  async *stream(session_id: string, from_seq = 0): AsyncGenerator<StoredEvent, void, unknown> {
    this.assertOpen();
    this.requireSessionRow(session_id);
    // Existing events first, then poll. The generator is pull-driven, so
    // polling happens only when the consumer awaits the next value —
    // backpressure is inherent. A `break` in for-await suspends the generator
    // at its yield point and it never polls again.
    let lastSeq = from_seq - 1;
    for (const row of this.readEventsAfter(session_id, from_seq)) {
      lastSeq = row.seq;
      yield this.rowToStored(row);
    }
    while (true) {
      await sleep(STREAM_POLL_MS);
      this.assertOpen();
      for (const row of this.readEventsAfter(session_id, lastSeq + 1)) {
        lastSeq = row.seq;
        yield this.rowToStored(row);
      }
    }
  }

  async fork(session_id: string, at_seq: number): Promise<SessionMeta> {
    this.assertOpen();
    if (!Number.isInteger(at_seq) || at_seq < 1) {
      throw new SessionStoreError("validation_failed", "fork: at_seq must be an integer >= 1");
    }
    const parent = this.requireSessionRow(session_id);
    const childId = nanoid();
    const now = Date.now();
    const txn = this.db.transaction((): SessionMeta => {
      this.dz
        .insert(schema.sessions)
        .values({
          id: childId,
          parentId: session_id,
          ownerId: parent.owner_id,
          personaId: parent.persona_id,
          title: `${parent.title} (fork)`,
          createdAt: now,
          updatedAt: now,
          engagementJson: parent.engagement_json,
          metadataJson: null,
        })
        .run();
      // Re-append the parent's prefix under the child: fresh global seqs,
      // payload session_id rewritten to the child, everything else identical.
      const rows = this.stmts.readEventsUpTo.all(session_id, at_seq) as EventRow[];
      for (const row of rows) {
        const payload = JSON.parse(row.payload_json) as SessionEvent & { session_id: string };
        payload.session_id = childId;
        const info = this.stmts.insertEvent.run(childId, row.type, canonicalJson(payload), row.ts);
        applyProjectionEvent(this.projectionStmts, {
          ...payload,
          seq: Number(info.lastInsertRowid),
        });
      }
      if (rows.length > 0) this.stmts.touchSession.run(now, childId);
      // The fork is recorded on the parent's own log.
      const forked: SessionEvent = {
        type: "session.forked",
        session_id,
        new_session_id: childId,
        at_seq,
        ts: now,
      };
      this.insertEvents(session_id, [forked], now);
      return this.rowToMeta(this.requireSessionRow(childId));
    });
    return txn();
  }

  async meta(session_id: string): Promise<SessionMeta | null> {
    this.assertOpen();
    const row = this.selectSessionRow(session_id);
    return row === undefined ? null : this.rowToMeta(row);
  }

  async list(opts?: { limit?: number; owner_id?: string }): Promise<SessionMeta[]> {
    this.assertOpen();
    const limit = opts?.limit ?? LIST_DEFAULT_LIMIT;
    if (limit < 0) {
      throw new SessionStoreError("validation_failed", "list: limit must be >= 0");
    }
    const rows = this.dz
      .select()
      .from(schema.sessions)
      .where(opts?.owner_id !== undefined ? eq(schema.sessions.ownerId, opts.owner_id) : undefined)
      .orderBy(desc(schema.sessions.updatedAt), schema.sessions.id)
      .limit(limit)
      .all();
    return rows.map((row) =>
      this.rowToMeta({
        id: row.id,
        parent_id: row.parentId,
        owner_id: row.ownerId,
        persona_id: row.personaId,
        title: row.title,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        engagement_json: row.engagementJson,
        metadata_json: row.metadataJson,
      }),
    );
  }

  async projection(session_id: string): Promise<Projection> {
    this.assertOpen();
    this.requireSessionRow(session_id);
    const messageRows = this.dz
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.sessionId, session_id))
      .orderBy(schema.messages.seq)
      .all();
    const toolCallRows = this.dz
      .select()
      .from(schema.toolCalls)
      .where(eq(schema.toolCalls.sessionId, session_id))
      .orderBy(schema.toolCalls.seq)
      .all();
    const approvalRows = this.dz
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.sessionId, session_id))
      .orderBy(schema.approvals.createdAt, schema.approvals.id)
      .all();
    const messages: Message[] = messageRows.map((row) => ({
      role: row.role as Message["role"],
      content: JSON.parse(row.contentJson) as ContentBlock[],
    }));
    const tool_calls: ToolCallRecord[] = toolCallRows.map((row) => ({
      call_id: row.id.slice(session_id.length + 1),
      turn_id: row.turnId,
      name: row.name,
      input: JSON.parse(row.inputJson),
      output: row.outputJson === null ? null : JSON.parse(row.outputJson),
      status: row.status as ToolCallRecord["status"],
      ts: row.ts,
    }));
    const approvals: ApprovalRecord[] = approvalRows.map((row) => ({
      id: row.id.slice(session_id.length + 1),
      session_id: row.sessionId,
      turn_id: row.turnId,
      action_digest: row.actionDigest,
      summary: row.summary,
      risk: row.risk as RiskTier,
      decision: row.decision as ApprovalRecord["decision"],
      decided_by: row.decidedBy,
      created_at: row.createdAt,
      expires_at: row.expiresAt,
      used_at: row.usedAt,
    }));
    return {
      session_id,
      last_seq: this.lastSeq(session_id),
      messages,
      tool_calls,
      approvals,
      usage: this.usageOf(session_id),
    };
  }

  async rebuildProjections(): Promise<void> {
    this.assertOpen();
    const rebuild = this.db.transaction(() => {
      this.db.exec(
        "DELETE FROM messages; DELETE FROM tool_calls; DELETE FROM approvals; DELETE FROM projection_version;",
      );
      // Global seq order preserves every session's per-session order, so
      // replaying globally reproduces the incremental tables byte-for-byte.
      const PAGE = 5000;
      let after = 0;
      for (;;) {
        const rows = this.stmts.eventsPage.all(after, PAGE) as EventRow[];
        if (rows.length === 0) break;
        for (const row of rows) {
          const ev = JSON.parse(row.payload_json) as SessionEvent;
          applyProjectionEvent(this.projectionStmts, { ...ev, seq: row.seq });
        }
        after = rows[rows.length - 1]!.seq;
      }
    });
    rebuild();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // A shared handle (opts.db) is closed by its provider, not by us.
    if (this.ownsDb) this.db.close();
  }

  // ---- internals ---------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) {
      throw new SessionStoreError("closed", "session store is closed");
    }
  }

  private selectSessionRow(session_id: string): SessionRow | undefined {
    return this.stmts.selectSession.get(session_id) as SessionRow | undefined;
  }

  private requireSessionRow(session_id: string): SessionRow {
    const row = this.selectSessionRow(session_id);
    if (row === undefined) {
      throw new SessionStoreError("not_found", `session ${session_id} not found`);
    }
    return row;
  }

  private rowToMeta(row: SessionRow): SessionMeta {
    return {
      session_id: row.id,
      parent_id: row.parent_id,
      owner_id: row.owner_id,
      persona_id: row.persona_id,
      title: row.title,
      created_at: row.created_at,
      updated_at: row.updated_at,
      engagement:
        row.engagement_json === null ? null : (JSON.parse(row.engagement_json) as Engagement),
    };
  }

  private rowToStored(row: EventRow): StoredEvent {
    const stored: StoredEvent = { ...(JSON.parse(row.payload_json) as SessionEvent), seq: row.seq };
    if (this.validate) {
      const parsed = StoredEventSchema.safeParse(stored);
      if (!parsed.success) {
        throw new SessionStoreError(
          "validation_failed",
          `stored event seq=${row.seq} failed schema validation: ${parsed.error.message}`,
        );
      }
    }
    return stored;
  }

  private readEventsAfter(session_id: string, from_seq: number): EventRow[] {
    return this.stmts.readEvents.all(session_id, from_seq, -1) as EventRow[];
  }

  private lastSeq(session_id: string): number {
    const row = this.stmts.selectLastSeq.get(session_id) as LastSeqRow | undefined;
    return row?.last_seq ?? 0;
  }

  private usageOf(session_id: string): Usage {
    let usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    for (const row of this.stmts.usageEvents.all(session_id) as UsageEventRow[]) {
      usage = mergeUsage(usage, (JSON.parse(row.payload_json) as { usage: Usage }).usage);
    }
    return usage;
  }

  private debugValidateEvent(ev: SessionEvent): void {
    const parsed = SessionEventSchema.safeParse(ev);
    if (!parsed.success) {
      throw new SessionStoreError(
        "validation_failed",
        `event failed schema validation: ${parsed.error.message}`,
      );
    }
  }

  /** Inserts events + maintains projections + touches the session. Runs inside a transaction. */
  private insertEvents(
    session_id: string,
    events: readonly SessionEvent[],
    now: number,
  ): StoredEvent[] {
    const stored: StoredEvent[] = [];
    for (const ev of events) {
      const info = this.stmts.insertEvent.run(session_id, ev.type, canonicalJson(ev), ev.ts);
      const se: StoredEvent = { ...ev, seq: Number(info.lastInsertRowid) };
      applyProjectionEvent(this.projectionStmts, se);
      stored.push(se);
    }
    if (events.length > 0) this.stmts.touchSession.run(now, session_id);
    return stored;
  }
}

/**
 * Opens (creating and migrating if needed) the session store at `path`.
 * `:memory:` works. Pass `opts.db` to share an existing better-sqlite3
 * handle — migrations run idempotently and the handle is never closed by
 * the store itself.
 */
export function openSessionStore(path: string, opts?: SessionStoreOptions): SessionStore {
  return new SessionStoreImpl(path, opts ?? {});
}
