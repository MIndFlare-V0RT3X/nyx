// SPDX-License-Identifier: AGPL-3.0-or-later
// 2.1.1 acceptance: the approval engine routes request() through a registered
// presenter (channel surface) with a 5-minute channel TTL, calls withdraw() on
// expiry and on unregister, and keeps concurrent sessions on their own
// presenters. Without a presenter the TTY/poll path is unchanged.

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { ApprovalEngineImpl, DEFAULT_CHANNEL_APPROVAL_TTL_MS } from "./approvals.js";
import type { ApprovalPresenter, ApprovalRequest } from "./approvals.js";
import type { PolicyVerdict } from "@nyx/protocol";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nyx-presenter-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function openEngine(opts: { now?: () => number } = {}): ApprovalEngineImpl {
  const db = new Database(join(dir, `engine-${Math.random().toString(36).slice(2)}.db`));
  return new ApprovalEngineImpl(db, {
    poll_ms: 5,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

const VERDICT: PolicyVerdict = {
  decision: "ask",
  rule_id: "ask-r2",
  summary: "web.fetch on http://example.com [risk R2]",
  action_digest: "digest-abc",
};

class RecordingPresenter implements ApprovalPresenter {
  readonly id: string;
  presented: ApprovalRequest[] = [];
  withdrawn: Array<{ approval_id: string; reason: string }> = [];
  failPresent = false;

  constructor(id: string) {
    this.id = id;
  }

  async present(req: ApprovalRequest): Promise<void> {
    if (this.failPresent) throw new Error("telegram down");
    this.presented.push(req);
  }

  async withdraw(approval_id: string, reason: string): Promise<void> {
    this.withdrawn.push({ approval_id, reason });
  }
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe("ApprovalEngineImpl presenters (2.1.1)", () => {
  it("routes request() to the session's presenter; resolve() unblocks it", async () => {
    const engine = openEngine();
    const presenter = new RecordingPresenter("telegram:1");
    engine.registerPresenter("sess-1", presenter);

    let decision: "allow" | "deny" | undefined;
    const request = engine.request(VERDICT, {
      session_id: "sess-1",
      turn_id: "t1",
      actor_id: "agent",
    });
    void request.then((d) => {
      decision = d;
    });
    await settle();
    expect(presenter.presented).toHaveLength(1);
    expect(presenter.presented[0]).toMatchObject({
      session_id: "sess-1",
      turn_id: "t1",
      summary: VERDICT.summary,
      risk: "R2",
      action_digest: "digest-abc",
    });
    // Channel TTL default: 5 minutes.
    expect(presenter.presented[0]!.expires_at - Date.now()).toBeLessThanOrEqual(
      DEFAULT_CHANNEL_APPROVAL_TTL_MS,
    );
    expect(presenter.presented[0]!.expires_at - Date.now()).toBeGreaterThan(
      DEFAULT_CHANNEL_APPROVAL_TTL_MS - 10_000,
    );

    await engine.resolve(presenter.presented[0]!.approval_id, "allow", "telegram:42");
    expect(await request).toBe("allow");
    expect(decision).toBe("allow");
  });

  it("honors a per-presenter TTL override", async () => {
    const engine = openEngine();
    const presenter = new RecordingPresenter("webhook");
    engine.registerPresenter("sess-2", presenter, { ttl_ms: 1_000 });
    const request = engine.request(VERDICT, {
      session_id: "sess-2",
      turn_id: "t2",
      actor_id: "agent",
    });
    await settle();
    expect(presenter.presented[0]!.expires_at - Date.now()).toBeLessThanOrEqual(1_000);
    await engine.resolve(presenter.presented[0]!.approval_id, "deny", "operator");
    expect(await request).toBe("deny");
  });

  it("expiry auto-denies AND withdraws the presenter's request", async () => {
    const engine = openEngine();
    const presenter = new RecordingPresenter("telegram:9");
    engine.registerPresenter("sess-3", presenter, { ttl_ms: 30 });
    const request = engine.request(VERDICT, {
      session_id: "sess-3",
      turn_id: "t3",
      actor_id: "agent",
    });
    await settle();
    const approvalId = presenter.presented[0]!.approval_id;
    await new Promise((r) => setTimeout(r, 80));
    expect(await request).toBe("deny");
    expect(presenter.withdrawn).toEqual([{ approval_id: approvalId, reason: "expired" }]);
    const record = await engine.get(approvalId);
    expect(record?.decision).toBe("deny");
    expect(record?.decided_by).toBe("system:expiry");
  });

  it("unregisterPresenter denies and withdraws pending approvals of the session", async () => {
    const engine = openEngine();
    const presenter = new RecordingPresenter("telegram:10");
    engine.registerPresenter("sess-4", presenter, { ttl_ms: 600_000 });
    const request = engine.request(VERDICT, {
      session_id: "sess-4",
      turn_id: "t4",
      actor_id: "agent",
    });
    await settle();
    const approvalId = presenter.presented[0]!.approval_id;

    engine.unregisterPresenter("sess-4");
    expect(await request).toBe("deny");
    expect(presenter.withdrawn).toEqual([
      { approval_id: approvalId, reason: "presenter unregistered" },
    ]);
    const record = await engine.get(approvalId);
    expect(record?.decision).toBe("deny");
    expect(record?.decided_by).toBe("system:withdrawn");
  });

  it("concurrent approvals in two sessions route to their own presenters", async () => {
    const engine = openEngine();
    const p1 = new RecordingPresenter("telegram:1");
    const p2 = new RecordingPresenter("webhook");
    engine.registerPresenter("sess-a", p1, { ttl_ms: 600_000 });
    engine.registerPresenter("sess-b", p2, { ttl_ms: 600_000 });

    const r1 = engine.request(VERDICT, { session_id: "sess-a", turn_id: "ta", actor_id: "agent" });
    const r2 = engine.request(VERDICT, { session_id: "sess-b", turn_id: "tb", actor_id: "agent" });
    await settle();
    expect(p1.presented).toHaveLength(1);
    expect(p2.presented).toHaveLength(1);
    expect(p1.presented[0]!.session_id).toBe("sess-a");
    expect(p2.presented[0]!.session_id).toBe("sess-b");

    // Deny a, allow b — each decision lands on the right request.
    await engine.resolve(p2.presented[0]!.approval_id, "allow", "op");
    await engine.resolve(p1.presented[0]!.approval_id, "deny", "op");
    expect(await r1).toBe("deny");
    expect(await r2).toBe("allow");
  });

  it("a failing present() does not break the turn — TTL is the safety net", async () => {
    const engine = openEngine();
    const presenter = new RecordingPresenter("broken");
    presenter.failPresent = true;
    engine.registerPresenter("sess-5", presenter, { ttl_ms: 600_000 });
    const request = engine.request(VERDICT, {
      session_id: "sess-5",
      turn_id: "t5",
      actor_id: "agent",
    });
    await settle();
    // The approval row exists even though present() threw; the operator can
    // still resolve it out-of-band.
    const pending = await engine.pending("sess-5");
    expect(pending).toHaveLength(1);
    await engine.resolve(pending[0]!.id, "allow", "op");
    expect(await request).toBe("allow");
  });

  it("presenterSessions lists registered sessions; TTL default is 5 minutes", () => {
    expect(DEFAULT_CHANNEL_APPROVAL_TTL_MS).toBe(300_000);
    const engine = openEngine();
    engine.registerPresenter("s1", new RecordingPresenter("p1"));
    engine.registerPresenter("s2", new RecordingPresenter("p2"));
    expect(engine.presenterSessions().sort()).toEqual(["s1", "s2"]);
    engine.unregisterPresenter("s1");
    expect(engine.presenterSessions()).toEqual(["s2"]);
  });
});
