// SPDX-License-Identifier: AGPL-3.0-or-later
// The SubagentManager suite: spawn lifecycle (3.3), depth + budget + tool
// allowlist enforcement (3.4), abort propagation (3.5), isolation invariants
// (hard rules #1/#2/#3), and list()/depth_for().

import { describe, expect, it } from "vitest";
import { mockTextTurn } from "@nyx/model";
import type { SessionEvent, StoredEvent, ToolHandler } from "@nyx/protocol";
import type Database from "better-sqlite3";
import { SubagentMemory } from "./memory-view.js";
import { SubagentError } from "./errors.js";
import { requestSubagentAbort } from "./control.js";
import { makeSubagentHarness, type SubagentHarness } from "./harness.test.js";

const types = (events: readonly SessionEvent[]): string[] => events.map((e) => e.type);

const byType = <T extends SessionEvent["type"]>(
  events: readonly SessionEvent[],
  type: T,
): Array<Extract<SessionEvent, { type: T }>> =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

async function readAll(h: SubagentHarness, id: string): Promise<StoredEvent[]> {
  return h.store.read(id);
}

/** Impl-only accessor: subagent tokens allocated in a parent turn so far. */
function turnSpendOf(manager: unknown): (session: string, turn: string) => number {
  return (manager as { turnSpendOf(s: string, t: string): number }).turnSpendOf.bind(manager);
}

describe("3.3 — the simplest spawn", () => {
  it("creates an isolated subagent session and returns its summary", async () => {
    const h = await makeSubagentHarness();
    h.provider.script("count beans", [mockTextTurn("there are 42 beans")]);

    const result = await h.manager.spawn(
      { task: "count beans" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );

    expect(result.state).toBe("completed");
    expect(result.summary).toBe("there are 42 beans");
    expect(result.tokens_used).toBeGreaterThan(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();

    // Child session: kind subagent, parent lineage, persona inherited.
    const child = await h.store.meta(result.session_id);
    expect(child).toMatchObject({
      kind: "subagent",
      parent_id: h.parent.session_id,
      persona_id: h.parent.persona_id,
      owner_id: h.parent.owner_id,
    });

    // Child's own log: full turn, framed task as the initial user message.
    const childEvents = await readAll(h, result.session_id);
    expect(types(childEvents)).toEqual([
      "session.created",
      "subagent.spawned",
      "turn.started",
      "message.user",
      "text.delta",
      "text.delta",
      "message.assistant",
      "turn.completed",
      "subagent.completed",
    ]);
    const childUser = byType(childEvents, "message.user")[0]!;
    expect(childUser.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("You are a subagent. Your task: count beans."),
    });

    // Parent's log: ONLY the mirrored lifecycle events — the child's turn
    // events never leak (hard rule #3).
    const parentEvents = await readAll(h, h.parent.session_id);
    expect(types(parentEvents).filter((t) => !t.startsWith("subagent."))).toEqual([
      "session.created",
    ]);
    const spawned = byType(parentEvents, "subagent.spawned")[0]!;
    expect(spawned).toMatchObject({
      subagent_session_id: result.session_id,
      parent_session_id: h.parent.session_id,
      parent_turn_id: "t1",
      task: "count beans",
      depth: 1,
    });
    const completed = byType(parentEvents, "subagent.completed")[0]!;
    expect(completed).toMatchObject({
      subagent_session_id: result.session_id,
      summary: "there are 42 beans",
      tokens_used: result.tokens_used,
      duration_ms: result.duration_ms,
    });
    // The child's copy mirrors the same facts with the child as session_id.
    expect(byType(childEvents, "subagent.completed")[0]!).toMatchObject({
      session_id: result.session_id,
      subagent_session_id: result.session_id,
      parent_session_id: h.parent.session_id,
    });
  });

  it("fails the subagent when the child model errors (recovery finds no hint)", async () => {
    const h = await makeSubagentHarness();
    h.provider.script("doomed task", [
      { fail: { name: "ProviderError", message: "boom", code: "provider_error" } },
    ]);

    const result = await h.manager.spawn(
      { task: "doomed task" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );

    expect(result.state).toBe("failed");
    expect(result.error).toMatchObject({ message: expect.stringContaining("boom") });
    const childEvents = await readAll(h, result.session_id);
    expect(types(childEvents)).toContain("turn.failed");
    const parentEvents = await readAll(h, h.parent.session_id);
    const failed = byType(parentEvents, "subagent.failed")[0]!;
    expect(failed.subagent_session_id).toBe(result.session_id);
    expect(byType(childEvents, "subagent.failed")[0]!.subagent_session_id).toBe(result.session_id);
  });
});

describe("3.4 — depth enforcement", () => {
  it("rejects a spawn past max_depth with code depth_exceeded (no session created)", async () => {
    const h = await makeSubagentHarness({ config: { max_depth: 1 } });
    h.provider.script("first", [mockTextTurn("ok")]);

    const first = await h.manager.spawn(
      { task: "first" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    expect(first.state).toBe("completed");

    // Recursive attempt: hand the manager a parent ref pointing at the
    // (subagent) child session — depth 2 would exceed max_depth 1.
    await expect(
      h.manager.spawn({ task: "second" }, h.parentCtx, {
        session_id: first.session_id,
        turn_id: "t1",
      }),
    ).rejects.toMatchObject({ code: "depth_exceeded", name: "SubagentError" });

    // Nothing was created: exactly one subagent session exists.
    const children = await h.manager.list(h.parent.session_id);
    expect(children).toHaveLength(1);
  });

  it("rejects immediately when max_depth is 0", async () => {
    const h = await makeSubagentHarness({ config: { max_depth: 0 } });
    await expect(
      h.manager.spawn({ task: "x" }, h.parentCtx, {
        session_id: h.parent.session_id,
        turn_id: "t1",
      }),
    ).rejects.toMatchObject({ code: "depth_exceeded" });
  });

  it("max_depth_override may only tighten, never loosen", async () => {
    const h = await makeSubagentHarness({ config: { max_depth: 1 } });
    h.provider.script("loosen attempt", [mockTextTurn("ok")]);

    // An override ABOVE the config is clamped down: with max_depth 1, an
    // override of 99 still caps the ceiling at 1 — depth 1 from the root is
    // allowed…
    const child = await h.manager.spawn(
      { task: "loosen attempt", max_depth_override: 99 },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    expect(child.state).toBe("completed");
    // …but spawning FROM that subagent (depth 2) is rejected even with the
    // same 99 override — the config ceiling cannot be loosened.
    await expect(
      h.manager.spawn(
        { task: "deeper", max_depth_override: 99 },
        h.parentCtx,
        { session_id: child.session_id, turn_id: "t2" },
      ),
    ).rejects.toMatchObject({ code: "depth_exceeded" });

    // An override BELOW the config tightens: 0 forbids even depth 1.
    await expect(
      h.manager.spawn(
        { task: "tighten", max_depth_override: 0 },
        h.parentCtx,
        { session_id: h.parent.session_id, turn_id: "t3" },
      ),
    ).rejects.toMatchObject({ code: "depth_exceeded" });
  });

  it("depth_for returns the remaining depth from a session", async () => {
    const h = await makeSubagentHarness();
    h.provider.script("d", [mockTextTurn("ok")]);
    expect(await h.manager.depth_for(h.parent.session_id)).toBe(3);
    const child = await h.manager.spawn(
      { task: "d" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    expect(await h.manager.depth_for(child.session_id)).toBe(2);
  });
});

describe("3.4 — per-turn budget enforcement", () => {
  it("clamps a spec's budget to max_budget_tokens (less, never more)", async () => {
    const h = await makeSubagentHarness();
    h.provider.script("big", [mockTextTurn("ok")]);
    const r = await h.manager.spawn(
      { task: "big", budget_tokens: 10_000_000 },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    expect(r.state).toBe("completed");
    expect(turnSpendOf(h.manager as never)(
      h.parent.session_id,
      "t1",
    )).toBe(65_536); // clamped to the ceiling
  });

  it("rejects a spawn that would exceed max_total_per_turn (code budget_exceeded)", async () => {
    const h = await makeSubagentHarness({
      config: { max_total_per_turn: 100_000, default_budget_tokens: 60_000 },
    });
    h.provider.script("alpha-op", [mockTextTurn("ok")]);
    h.provider.script("beta-op", [mockTextTurn("ok")]);
    h.provider.script("gamma-op", [mockTextTurn("ok")]);

    const first = await h.manager.spawn(
      { task: "alpha-op" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    expect(first.state).toBe("completed");
    // 60k allocated; a second default spawn (60k) would total 120k > 100k.
    await expect(
      h.manager.spawn({ task: "beta-op" }, h.parentCtx, {
        session_id: h.parent.session_id,
        turn_id: "t1",
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded", name: "SubagentError" });
    // A SMALLER request still fits (arithmetic: 60k + 40k = 100k <= 100k).
    const third = await h.manager.spawn(
      { task: "gamma-op", budget_tokens: 40_000 },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    expect(third.state).toBe("completed");
    expect(turnSpendOf(h.manager as never)(
      h.parent.session_id,
      "t1",
    )).toBe(100_000);
  });

  it("a new parent turn starts from a zero allocation; unbindTurn clears it", async () => {
    const h = await makeSubagentHarness({
      config: { max_total_per_turn: 70_000, default_budget_tokens: 60_000 },
    });
    h.provider.script("alpha-op", [mockTextTurn("ok")]);
    h.provider.script("beta-op", [mockTextTurn("ok")]);
    h.provider.script("gamma-op", [mockTextTurn("ok")]);

    const first = await h.manager.spawn(
      { task: "alpha-op" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    expect(first.state).toBe("completed");
    // Same spend in t1 is over the cap…
    await expect(
      h.manager.spawn({ task: "beta-op" }, h.parentCtx, {
        session_id: h.parent.session_id,
        turn_id: "t1",
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    // …but a fresh turn t2 has the full budget again.
    const second = await h.manager.spawn(
      { task: "beta-op" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t2" },
    );
    expect(second.state).toBe("completed");
    h.manager.unbindTurn(h.parent.session_id);
    const third = await h.manager.spawn(
      { task: "gamma-op" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t3" },
    );
    expect(third.state).toBe("completed");
  });

  it("aborts the child at runtime when its spend crosses the budget", async () => {
    const h = await makeSubagentHarness({
      config: { default_budget_tokens: 1024 },
    });
    h.provider.script("burner", [
      [
        { type: "usage", usage: { input_tokens: 900, output_tokens: 900, total_tokens: 1800 } },
        { type: "text.delta", text: "partial" },
        { type: "done", finish_reason: "stop" },
      ],
    ]);

    const result = await h.manager.spawn(
      { task: "burner" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );

    expect(result.state).toBe("budget_exceeded");
    expect(result.error).toMatchObject({ code: "budget_exceeded" });
    const parentEvents = await readAll(h, h.parent.session_id);
    const failed = byType(parentEvents, "subagent.failed")[0]!;
    expect(failed.error.code).toBe("budget_exceeded");
    const childEvents = await readAll(h, result.session_id);
    expect(byType(childEvents, "subagent.failed")[0]!.error.code).toBe("budget_exceeded");
  });
});

describe("3.4 — tool allowlist (structural)", () => {
  it("the child's registry lacks spawn_subagent even when the spec asks for it", async () => {
    const h = await makeSubagentHarness();
    // The child tries to call spawn_subagent: in ITS registry the tool does
    // not exist — clean "unknown tool", not a policy denial.
    h.provider.script("recursive", [
      [
        {
          type: "tool_call.delta",
          index: 0,
          id: "c1",
          name: "spawn_subagent",
          arguments_delta: '{"task":"grandchild"}',
        },
        { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        { type: "done", finish_reason: "tool_calls" },
      ],
      mockTextTurn("i could not spawn"),
    ]);

    const result = await h.manager.spawn(
      { task: "recursive", tools: ["spawn_subagent", "fs.read"] },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );

    expect(result.state).toBe("completed");
    const childEvents = await readAll(h, result.session_id);
    const toolError = byType(childEvents, "tool.error")[0]!;
    expect(toolError).toMatchObject({
      call_id: "c1",
      error: { code: "tool_unknown" },
    });
    // Exactly one subagent session exists — no grandchild.
    expect(await h.manager.list(h.parent.session_id)).toHaveLength(1);
  });

  it("filters the child's tools to the spec allowlist minus forbidden tools", async () => {
    const h = await makeSubagentHarness({
      config: { forbidden_tools: ["shell.exec", "spawn_subagent"] },
    });
    // fs.list is NOT in the spec's allowlist (only fs.read is; shell.exec is
    // forbidden by config); the child calling it gets "unknown tool".
    h.provider.script("narrow", [
      [
        {
          type: "tool_call.delta",
          index: 0,
          id: "c1",
          name: "fs.list",
          arguments_delta: '{"path":"."}',
        },
        { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        { type: "done", finish_reason: "tool_calls" },
      ],
      [
        {
          type: "tool_call.delta",
          index: 0,
          id: "c2",
          name: "fs.read",
          arguments_delta: '{"path":"hello.txt"}',
        },
        { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        { type: "done", finish_reason: "tool_calls" },
      ],
      mockTextTurn("done"),
    ]);

    const result = await h.manager.spawn(
      { task: "narrow", tools: ["fs.read", "shell.exec"] },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );

    expect(result.state).toBe("completed");
    const childEvents = await readAll(h, result.session_id);
    const errors = byType(childEvents, "tool.error");
    expect(errors.map((e) => e.call_id)).toEqual(["c1"]); // fs.list: unknown tool
    const ok = byType(childEvents, "tool.result")[0]!;
    expect(ok.call_id).toBe("c2"); // fs.read: allowed, shared sandbox read
    expect(ok.output).toMatchObject({ kind: "text", text: "shared sandbox file" });
  });

  it("wires the child with the filtered registry, isolated memory, and shared sandbox", async () => {
    const h = await makeSubagentHarness();
    h.provider.script("wiring", [
      [
        {
          type: "tool_call.delta",
          index: 0,
          id: "c1",
          name: "fs.read",
          arguments_delta: '{"path":"hello.txt"}',
        },
        { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        { type: "done", finish_reason: "tool_calls" },
      ],
      mockTextTurn("done"),
    ]);

    const result = await h.manager.spawn(
      { task: "wiring" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    expect(result.state).toBe("completed");

    // The action.after hook captured the CHILD's RunContext.
    const childCtx = h.capturedContexts.get(result.session_id);
    expect(childCtx).toBeDefined();
    expect(childCtx!.tools.list().map((d) => d.name)).not.toContain("spawn_subagent");
    expect(childCtx!.memory).toBeInstanceOf(SubagentMemory);
    // The shared sandbox (§2.5): same instance as the parent's.
    expect(childCtx!.sandbox).toBe(h.parentCtx.sandbox);
    // The parent's registry DOES contain spawn_subagent (only children lose it).
    expect(h.parentCtx.tools.get("spawn_subagent")).not.toBeNull();
  });
});

describe("3.5 — abort propagation", () => {
  it("parent signal aborts the child; subagent.aborted lands on both logs", async () => {
    const slow: ToolHandler = {
      execute: () => new Promise(() => undefined), // never resolves; abort kills it
    };
    const h2 = await makeSubagentHarness({
      extraTools: [{ name: "test.slow", handler: slow }],
    });
    h2.provider.script("slowpoke", [
      [
        {
          type: "tool_call.delta",
          index: 0,
          id: "c1",
          name: "test.slow",
          arguments_delta: "{}",
        },
        { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        { type: "done", finish_reason: "tool_calls" },
      ],
      mockTextTurn("never reached"),
    ]);

    const spawned = h2.manager.spawn(
      { task: "slowpoke", tools: ["test.slow"] },
      h2.parentCtx,
      { session_id: h2.parent.session_id, turn_id: "t1" },
    );
    await new Promise((r) => setTimeout(r, 60));
    h2.parentController.abort();
    const result = await spawned;

    expect(result.state).toBe("aborted");
    expect(result.error).toMatchObject({ code: "aborted" });
    const parentEvents = await readAll(h2, h2.parent.session_id);
    const aborted = byType(parentEvents, "subagent.aborted")[0]!;
    expect(aborted.reason).toBe("parent turn aborted");
    expect(aborted.subagent_session_id).toBe(result.session_id);
    const childEvents = await readAll(h2, result.session_id);
    expect(byType(childEvents, "subagent.aborted")[0]!.reason).toBe("parent turn aborted");
    // The child's own turn ended on the record as aborted.
    const turnFailed = byType(childEvents, "turn.failed")[0]!;
    expect(turnFailed.error.code).toBe("aborted");
  });

  it("manager.abort() aborts a running subagent in-process", async () => {
    const h = await makeSubagentHarness({
      extraTools: [
        { name: "test.slow", handler: { execute: () => new Promise(() => undefined) } },
      ],
    });
    let childId = "";
    const spawned = h.manager.spawn(
      { task: "slowpoke", tools: ["test.slow"] },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    h.provider.script("slowpoke", [
      [
        {
          type: "tool_call.delta",
          index: 0,
          id: "c1",
          name: "test.slow",
          arguments_delta: "{}",
        },
        { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        { type: "done", finish_reason: "tool_calls" },
      ],
      mockTextTurn("never"),
    ]);
    // Learn the child id via the parent's spawned event.
    await new Promise((resolve) => {
      const timer = setInterval(async () => {
        const events = await h.store.read(h.parent.session_id);
        const spawnedEvent = events.find((e) => e.type === "subagent.spawned");
        if (spawnedEvent !== undefined) {
          childId = (spawnedEvent as { subagent_session_id: string }).subagent_session_id;
          clearInterval(timer);
          resolve(undefined);
        }
      }, 10);
    });
    await h.manager.abort(childId);
    const result = await spawned;
    expect(result.state).toBe("aborted");
    const parentEvents = await readAll(h, h.parent.session_id);
    expect(byType(parentEvents, "subagent.aborted")[0]!.reason).toBe("abort requested");
  });

  it("a cross-process abort request (control row) aborts the running child", async () => {
    const h = await makeSubagentHarness({
      extraTools: [
        { name: "test.slow", handler: { execute: () => new Promise(() => undefined) } },
      ],
    });
    // A second better-sqlite3 handle stands in for the OTHER process.
    const Database = (await import("better-sqlite3")).default;
    const otherDb: Database.Database = new Database(":memory:");
    let childId = "";
    h.provider.script("slowpoke", [
      [
        {
          type: "tool_call.delta",
          index: 0,
          id: "c1",
          name: "test.slow",
          arguments_delta: "{}",
        },
        { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        { type: "done", finish_reason: "tool_calls" },
      ],
      mockTextTurn("never"),
    ]);

    // The manager's cross-process poll needs a SHARED db: :memory: databases
    // are per-handle, so give the manager a file-backed db instead.
    const h2 = await makeSubagentHarness({
      extraTools: [
        { name: "test.slow", handler: { execute: () => new Promise(() => undefined) } },
      ],
    });
    const sharedDb: Database.Database = new Database(":memory:");
    const managerWithDb = await (
      await import("./manager.js")
    ).createSubagentManager({
      store: h2.store,
      db: sharedDb,
      poll_ms: 20,
    });
    h2.provider.script("slowpoke", [
      [
        {
          type: "tool_call.delta",
          index: 0,
          id: "c1",
          name: "test.slow",
          arguments_delta: "{}",
        },
        { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        { type: "done", finish_reason: "tool_calls" },
      ],
      mockTextTurn("never"),
    ]);

    const spawned = managerWithDb.spawn(
      { task: "slowpoke", tools: ["test.slow"] },
      h2.parentCtx,
      { session_id: h2.parent.session_id, turn_id: "t1" },
    );
    await new Promise((resolve) => {
      const timer = setInterval(async () => {
        const events = await h2.store.read(h2.parent.session_id);
        const found = events.find((e) => e.type === "subagent.spawned");
        if (found !== undefined) {
          childId = (found as { subagent_session_id: string }).subagent_session_id;
          clearInterval(timer);
          resolve(undefined);
        }
      }, 10);
    });
    // The "other process" writes the abort request into ITS view of the db.
    requestSubagentAbort(sharedDb, childId, "cli:test");
    const result = await spawned;
    expect(result.state).toBe("aborted");
    const parentEvents = await readAll(h2, h2.parent.session_id);
    expect(byType(parentEvents, "subagent.aborted")[0]!.reason).toBe("abort requested (external)");
    sharedDb.close();
    otherDb.close();
  });
});

describe("isolation invariants (hard rules #2/#3)", () => {
  it("child events never appear in the parent's log — only summaries cross", async () => {
    const h = await makeSubagentHarness();
    h.provider.script("isolated", [mockTextTurn("the summary")]);
    const result = await h.manager.spawn(
      { task: "isolated" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    const parentEvents = await readAll(h, h.parent.session_id);
    for (const e of parentEvents) {
      if (e.type === "subagent.spawned" || e.type === "subagent.completed") continue;
      expect((e as { session_id: string }).session_id).toBe(h.parent.session_id);
    }
    // No child turn events leaked: the parent log has exactly 1 + 2 rows.
    expect(parentEvents).toHaveLength(3);
    // …and the summary IS in the parent's completed event.
    expect(byType(parentEvents, "subagent.completed")[0]!.summary).toBe("the summary");
    void result;
  });

  it("subagent memory: writes map to the subagent scope, parent session scope is unreachable", async () => {
    const h = await makeSubagentHarness();
    // The parent's session memory — what the child must NOT read.
    await h.memory.write({
      scope: "session",
      kind: "fact",
      content: "parent secret session memory",
      tags: [],
      source: { session_id: h.parent.session_id },
    });
    await h.memory.write({
      scope: "global",
      kind: "fact",
      content: "global fact visible to everyone",
      tags: [],
      source: {},
    });

    h.provider.script("memreader", [
      [
        {
          type: "tool_call.delta",
          index: 0,
          id: "c1",
          name: "fs.read",
          arguments_delta: '{"path":"hello.txt"}',
        },
        { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        { type: "done", finish_reason: "tool_calls" },
      ],
      mockTextTurn("done"),
    ]);
    const result = await h.manager.spawn(
      { task: "memreader" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    const childCtx = h.capturedContexts.get(result.session_id)!;
    const childMemory = childCtx.memory;

    // Reads: own (empty) subagent view + global — never the parent's session scope.
    const visible = await childMemory.list({ limit: 50 });
    expect(visible.map((m) => m.content)).toEqual(["global fact visible to everyone"]);
    expect(await childMemory.search("parent secret")).toEqual([]);
    expect(
      (await childMemory.list({ scope: ["session"], limit: 50 })).map((m) => m.content),
    ).toEqual([]);

    // Writes: "session" maps to subagent:<child>; other scopes are rejected.
    const written = await childMemory.write({
      scope: "session",
      kind: "episode",
      content: "child memory of the task",
      tags: ["session-memory"],
      source: { session_id: result.session_id },
    });
    expect(written.scope).toBe("subagent");
    expect(written.source.session_id).toBe(result.session_id);
    await expect(
      childMemory.write({
        scope: "global",
        kind: "fact",
        content: "nope",
        tags: [],
        source: {},
      }),
    ).rejects.toMatchObject({ name: "SubagentMemoryError" });
    await expect(
      childMemory.write({
        scope: "persona",
        kind: "fact",
        content: "nope",
        tags: [],
        source: {},
      }),
    ).rejects.toMatchObject({ name: "SubagentMemoryError" });

    // The mapped write is invisible to the parent's session-scope view…
    const parentSessionView = await h.memory.list({ scope: ["session"], limit: 50 });
    expect(parentSessionView.map((m) => m.content)).toEqual(["parent secret session memory"]);
    // …but visible to the child's own view (scope "session" translates).
    const own = await childMemory.list({ scope: ["session"], limit: 50 });
    expect(own.map((m) => m.content)).toEqual(["child memory of the task"]);
    // compact() is a no-op for a subagent.
    expect(await childMemory.compact()).toEqual({ merged: 0, dropped: 0 });
  });
});

describe("list() and turn bindings", () => {
  it("lists children with states, excluding archived ones", async () => {
    const h = await makeSubagentHarness();
    h.provider.script("alpha", [mockTextTurn("a")]);
    h.provider.script("beta", [{ fail: { name: "E", message: "x", code: "provider_error" } }]);
    const a = await h.manager.spawn(
      { task: "alpha" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    const b = await h.manager.spawn(
      { task: "beta" },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );

    let infos = await h.manager.list(h.parent.session_id);
    expect(infos.map((i) => i.state).sort()).toEqual(["completed", "failed"]);
    expect(infos.map((i) => i.parent_turn_id)).toEqual(["t1", "t1"]);
    expect(infos.map((i) => i.task)).toEqual(expect.arrayContaining(["alpha", "beta"]));

    // Archive one child: hidden from list, still resolvable.
    await h.store.archiveSession(b.session_id);
    infos = await h.manager.list(h.parent.session_id);
    expect(infos.map((i) => i.session_id)).toEqual([a.session_id]);
    expect((await h.store.meta(b.session_id))?.kind).toBe("subagent");
  });

  it("bindTurn/unbindTurn gate the tool path's parent lookup", async () => {
    const h = await makeSubagentHarness({ registerSpawnTool: false });
    const { registerSubagentTool } = await import("./tool.js");
    registerSubagentTool(h.toolRegistry, { manager: h.manager, config: h.config });
    const tool = h.toolRegistry.get("spawn_subagent")!;

    await expect(
      tool.handler.execute(
        { call_id: "c1", name: "spawn_subagent", input: { task: "x" } },
        {
          session_id: h.parent.session_id,
          turn_id: "t9",
          call_id: "c1",
          sandbox: h.sandbox,
          signal: new AbortController().signal,
          logger: h.parentCtx.logger,
          emit: () => undefined,
          engagement: null,
        },
      ),
    ).rejects.toMatchObject({ code: "no_parent_context" });

    h.manager.bindTurn(h.parent.session_id, "t9", h.parentCtx);
    h.provider.script("x", [mockTextTurn("bound")]);
    const output = await tool.handler.execute(
      { call_id: "c1", name: "spawn_subagent", input: { task: "x" } },
      {
        session_id: h.parent.session_id,
        turn_id: "t9",
        call_id: "c1",
        sandbox: h.sandbox,
        signal: new AbortController().signal,
        logger: h.parentCtx.logger,
        emit: () => undefined,
        engagement: null,
      },
    );
    expect(output).toMatchObject({
      kind: "json",
      json: { state: "completed", summary: "bound" },
    });
    h.manager.unbindTurn(h.parent.session_id);
  });
});

describe("rejection paths surface as typed SubagentErrors", () => {
  it("validation: empty task", async () => {
    const h = await makeSubagentHarness();
    await expect(
      h.manager.spawn({ task: "  " }, h.parentCtx, {
        session_id: h.parent.session_id,
        turn_id: "t1",
      }),
    ).rejects.toBeInstanceOf(SubagentError);
  });

  it("sandbox_sharing fork is Phase 4+", async () => {
    const h = await makeSubagentHarness({ config: { sandbox_sharing: "fork" } });
    await expect(
      h.manager.spawn({ task: "x" }, h.parentCtx, {
        session_id: h.parent.session_id,
        turn_id: "t1",
      }),
    ).rejects.toMatchObject({ code: "not_supported" });
  });
});

describe("concurrent spawn allocation (Reviewer-1 hardening)", () => {
  it("two same-turn spawns racing on the budget: exactly one wins", async () => {
    const h = await makeSubagentHarness({
      config: { max_total_per_turn: 100_000, default_budget_tokens: 60_000 },
    });
    h.provider.script("race-one", [mockTextTurn("one")]);
    h.provider.script("race-two", [mockTextTurn("two")]);

    // Both spawns start in the same tick — the check-then-set allocation is
    // synchronous between awaits, so exactly one may reserve the budget.
    const settled = await Promise.allSettled([
      h.manager.spawn({ task: "race-one" }, h.parentCtx, {
        session_id: h.parent.session_id,
        turn_id: "t1",
      }),
      h.manager.spawn({ task: "race-two" }, h.parentCtx, {
        session_id: h.parent.session_id,
        turn_id: "t1",
      }),
    ]);
    const won = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "budget_exceeded",
    });
    expect(turnSpendOf(h.manager as never)(h.parent.session_id, "t1")).toBe(60_000);
  });

  it("an allowlist naming tools the parent doesn't have grants nothing", async () => {
    const h = await makeSubagentHarness();
    h.provider.script("phantom tools", [
      [
        {
          type: "tool_call.delta",
          index: 0,
          id: "c1",
          name: "fs.read",
          arguments_delta: '{"path":"hello.txt"}',
        },
        { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        { type: "done", finish_reason: "tool_calls" },
      ],
      mockTextTurn("no tools at all"),
    ]);
    // "grep" is not registered on the parent registry → the child's allowlist
    // is EMPTY (fs.read exists but is not in the spec either).
    const result = await h.manager.spawn(
      { task: "phantom tools", tools: ["grep"] },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    expect(result.state).toBe("completed");
    const childEvents = await readAll(h, result.session_id);
    expect(byType(childEvents, "tool.error")[0]).toMatchObject({
      error: { code: "tool_unknown" },
    });
  });
});
