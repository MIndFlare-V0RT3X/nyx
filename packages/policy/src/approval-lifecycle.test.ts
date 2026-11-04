// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 0 verification item 0.2 (kept as a permanent regression test):
// the approval lifecycle's two load-bearing guarantees. Run directly via:
//   pnpm --filter @nyx/policy test -- approval-lifecycle
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ApprovalEngineImpl } from "./approvals.js";
import type { PolicyVerdict } from "@nyx/protocol";

type DB = Database.Database;

const dbs: DB[] = [];

function freshDb(): DB {
  const db = new Database(":memory:");
  dbs.push(db);
  return db;
}

afterAll(() => {
  for (const db of dbs) db.close();
});

const CTX = { session_id: "s-lifecycle", turn_id: "t-lifecycle", actor_id: "agent" };

function verdict(digest: string): PolicyVerdict {
  return {
    decision: "ask",
    rule_id: "invariant:dangerous-capability",
    action_digest: digest,
    summary: '"shell.exec" on {"cmd":"rm -rf /tmp/x"} [risk R4]',
  };
}

/** The row a pending request() call has inserted, once it is visible. */
async function pendingRowFor(db: DB, digest: string): Promise<{ id: string }> {
  for (let i = 0; i < 50; i += 1) {
    const row = db
      .prepare(
        "SELECT id FROM approvals WHERE action_digest = ? AND decision = 'pending'",
      )
      .get(digest) as { id: string } | undefined;
    if (row !== undefined) return row;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`no pending approval row appeared for ${digest}`);
}

describe("approval-lifecycle (Phase 0 verification 0.2)", () => {
  it("an approval resolved once cannot be reused for a second action", async () => {
    const db = freshDb();
    let clock = 1_000_000;
    const now = (): number => clock;
    const engine = new ApprovalEngineImpl(db, { now, poll_ms: 1, ttl_ms: 600_000 });

    // First action: request → allow → consume succeeds.
    const pending = engine.request(verdict("digest-A"), CTX);
    const row = await pendingRowFor(db, "digest-A");
    await engine.resolve(row.id, "allow", "owner");
    await expect(pending).resolves.toBe("allow");
    await expect(engine.consume(row.id, "digest-A")).resolves.toMatchObject({
      id: row.id,
      decision: "allow",
      used_at: expect.any(Number),
    });

    // Single-use: the same approval cannot authorize a second action.
    await expect(engine.consume(row.id, "digest-A")).rejects.toMatchObject({
      code: "approval_denied",
      message: expect.stringContaining("already consumed"),
    });

    // A different digest never matches either (exact-action binding).
    await expect(engine.consume(row.id, "digest-B")).rejects.toMatchObject({
      code: "approval_denied",
    });

    // Re-resolving a resolved approval is also refused.
    await expect(engine.resolve(row.id, "deny", "owner")).rejects.toMatchObject({
      code: "approval_denied",
      message: expect.stringContaining("already resolved"),
    });
  });

  it("an expired approval is rejected even though decision: allow was stored", async () => {
    const db = freshDb();
    let clock = 1_000_000;
    const now = (): number => clock;
    const engine = new ApprovalEngineImpl(db, { now, poll_ms: 1, ttl_ms: 600_000 });

    // Store the allow decision while the approval is still valid.
    const pending = engine.request(verdict("digest-E"), CTX);
    const row = await pendingRowFor(db, "digest-E");
    const { expires_at } = db
      .prepare("SELECT expires_at FROM approvals WHERE id = ?")
      .get(row.id) as { expires_at: number };
    await engine.resolve(row.id, "allow", "owner");
    await expect(pending).resolves.toBe("allow");

    // Advance past expires_at. The stored decision stays "allow"…
    clock = expires_at + 1;
    const stored = await engine.get(row.id);
    expect(stored?.decision).toBe("allow");

    // …but consume() must reject it server-side.
    await expect(engine.consume(row.id, "digest-E")).rejects.toMatchObject({
      code: "approval_expired",
      message: expect.stringContaining("expired"),
    });
  });
});
