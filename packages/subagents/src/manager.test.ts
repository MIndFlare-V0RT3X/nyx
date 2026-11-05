// SPDX-License-Identifier: AGPL-3.0-or-later
// The SubagentManager suite: spawn lifecycle (3.3), depth + budget + tool
// allowlist enforcement (3.4), abort propagation (3.5), isolation invariants
// (hard rules #1/#2/#3), and list()/depth_for().

import { describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mockTextTurn, mockToolTurn } from "@nyx/model";
import type { ApprovalEngineImpl, ApprovalPresenter } from "@nyx/policy";
import { createAgentLoop } from "@nyx/agent";
import type { AgentLoop, ModelChunk, SessionEvent, StoredEvent, ToolHandler } from "@nyx/protocol";
import type Database from "better-sqlite3";
import { SubagentMemory } from "./memory-view.js";
import { SubagentError } from "./errors.js";
import { requestSubagentAbort, listSubagentAbortRequests } from "./control.js";
import { makeSubagentHarness, TaskDispatchProvider, type SubagentHarness } from "./harness.test.js";

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

    const result = await h.manager.spawn({ task: "count beans" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });

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

    const result = await h.manager.spawn({ task: "doomed task" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });

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

    const first = await h.manager.spawn({ task: "first" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
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
      h.manager.spawn({ task: "deeper", max_depth_override: 99 }, h.parentCtx, {
        session_id: child.session_id,
        turn_id: "t2",
      }),
    ).rejects.toMatchObject({ code: "depth_exceeded" });

    // An override BELOW the config tightens: 0 forbids even depth 1.
    await expect(
      h.manager.spawn({ task: "tighten", max_depth_override: 0 }, h.parentCtx, {
        session_id: h.parent.session_id,
        turn_id: "t3",
      }),
    ).rejects.toMatchObject({ code: "depth_exceeded" });
  });

  it("depth_for returns the remaining depth from a session", async () => {
    const h = await makeSubagentHarness();
    h.provider.script("d", [mockTextTurn("ok")]);
    expect(await h.manager.depth_for(h.parent.session_id)).toBe(3);
    const child = await h.manager.spawn({ task: "d" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
    expect(await h.manager.depth_for(child.session_id)).toBe(2);
  });
});

describe("3.4 — per-turn budget enforcement", () => {
  it("clamps a spec's budget to max_budget_tokens (less, never more)", async () => {
    const h = await makeSubagentHarness();
    h.provider.script("big", [mockTextTurn("ok")]);
    const r = await h.manager.spawn({ task: "big", budget_tokens: 10_000_000 }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
    expect(r.state).toBe("completed");
    expect(turnSpendOf(h.manager as never)(h.parent.session_id, "t1")).toBe(65_536); // clamped to the ceiling
  });

  it("rejects a spawn that would exceed max_total_per_turn (code budget_exceeded)", async () => {
    const h = await makeSubagentHarness({
      config: { max_total_per_turn: 100_000, default_budget_tokens: 60_000 },
    });
    h.provider.script("alpha-op", [mockTextTurn("ok")]);
    h.provider.script("beta-op", [mockTextTurn("ok")]);
    h.provider.script("gamma-op", [mockTextTurn("ok")]);

    const first = await h.manager.spawn({ task: "alpha-op" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
    expect(first.state).toBe("completed");
    // 60k allocated; a second default spawn (60k) would total 120k > 100k.
    await expect(
      h.manager.spawn({ task: "beta-op" }, h.parentCtx, {
        session_id: h.parent.session_id,
        turn_id: "t1",
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded", name: "SubagentError" });
    // A SMALLER request still fits (arithmetic: 60k + 40k = 100k <= 100k).
    const third = await h.manager.spawn({ task: "gamma-op", budget_tokens: 40_000 }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
    expect(third.state).toBe("completed");
    expect(turnSpendOf(h.manager as never)(h.parent.session_id, "t1")).toBe(100_000);
  });

  it("a new parent turn starts from a zero allocation; unbindTurn clears it", async () => {
    const h = await makeSubagentHarness({
      config: { max_total_per_turn: 70_000, default_budget_tokens: 60_000 },
    });
    h.provider.script("alpha-op", [mockTextTurn("ok")]);
    h.provider.script("beta-op", [mockTextTurn("ok")]);
    h.provider.script("gamma-op", [mockTextTurn("ok")]);

    const first = await h.manager.spawn({ task: "alpha-op" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
    expect(first.state).toBe("completed");
    // Same spend in t1 is over the cap…
    await expect(
      h.manager.spawn({ task: "beta-op" }, h.parentCtx, {
        session_id: h.parent.session_id,
        turn_id: "t1",
      }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
    // …but a fresh turn t2 has the full budget again.
    const second = await h.manager.spawn({ task: "beta-op" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t2",
    });
    expect(second.state).toBe("completed");
    h.manager.unbindTurn(h.parent.session_id);
    const third = await h.manager.spawn({ task: "gamma-op" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t3",
    });
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

    const result = await h.manager.spawn({ task: "burner" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });

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

    const result = await h.manager.spawn({ task: "wiring" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
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

    const spawned = h2.manager.spawn({ task: "slowpoke", tools: ["test.slow"] }, h2.parentCtx, {
      session_id: h2.parent.session_id,
      turn_id: "t1",
    });
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
      extraTools: [{ name: "test.slow", handler: { execute: () => new Promise(() => undefined) } }],
    });
    let childId = "";
    const spawned = h.manager.spawn({ task: "slowpoke", tools: ["test.slow"] }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
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
    // BOTH logs carry the terminal event (in-process flavor).
    const childEvents = await readAll(h, result.session_id);
    expect(byType(childEvents, "subagent.aborted")[0]!.reason).toBe("abort requested");
  });

  it("a cross-process abort request (control row) aborts the running child", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-xproc-abort-"));
    const dbFile = path.join(dir, "nyx.db");
    const Database = (await import("better-sqlite3")).default;
    // TWO handles on one FILE: the manager's poll handle and a second
    // connection standing in for the CLI process that writes the request.
    const mgrDb: Database.Database = new Database(dbFile);
    const cliDb: Database.Database = new Database(dbFile);
    const h = await makeSubagentHarness({
      extraTools: [{ name: "test.slow", handler: { execute: () => new Promise(() => undefined) } }],
      managerDeps: { db: mgrDb, poll_ms: 20 },
    });
    h.provider.script("slowpoke", [
      mockToolTurn({ call_id: "c1", name: "test.slow", input: {} }),
      mockTextTurn("never"),
    ]);

    let childId = "";
    const spawned = h.manager.spawn({ task: "slowpoke", tools: ["test.slow"] }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
    await new Promise((resolve) => {
      const timer = setInterval(async () => {
        const events = await h.store.read(h.parent.session_id);
        const found = events.find((e) => e.type === "subagent.spawned");
        if (found !== undefined) {
          childId = (found as { subagent_session_id: string }).subagent_session_id;
          clearInterval(timer);
          resolve(undefined);
        }
      }, 10);
    });
    // The "other process" writes the abort request through ITS connection.
    requestSubagentAbort(cliDb, childId, "cli:test");
    const result = await spawned;
    expect(result.state).toBe("aborted");
    const parentEvents = await readAll(h, h.parent.session_id);
    expect(byType(parentEvents, "subagent.aborted")[0]!.reason).toBe("abort requested (external)");
    // BOTH logs carry the terminal event (asserted per abort flavor).
    const childEvents = await readAll(h, result.session_id);
    expect(byType(childEvents, "subagent.aborted")[0]!.reason).toBe("abort requested (external)");
    // The acted-on row is consumed — the next poll sees an empty table.
    await new Promise((r) => setTimeout(r, 40));
    expect(listSubagentAbortRequests(cliDb)).toEqual([]);
    mgrDb.close();
    cliDb.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe("isolation invariants (hard rules #2/#3)", () => {
  it("child events never appear in the parent's log — only summaries cross", async () => {
    const h = await makeSubagentHarness();
    h.provider.script("isolated", [mockTextTurn("the summary")]);
    const result = await h.manager.spawn({ task: "isolated" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
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
    const result = await h.manager.spawn({ task: "memreader" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
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
    const a = await h.manager.spawn({ task: "alpha" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
    const b = await h.manager.spawn({ task: "beta" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });

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

  it("fork mode on a non-forkable sandbox is a LOUD not_supported (never silent sharing)", async () => {
    // TmpSandbox has no fork(): the harness default is inherit, so an
    // explicit fork config against it must refuse — a silent fallback to
    // sharing would reintroduce exactly what Phase 4 §4 removes.
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
    const result = await h.manager.spawn({ task: "phantom tools", tools: ["grep"] }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
    expect(result.state).toBe("completed");
    const childEvents = await readAll(h, result.session_id);
    expect(byType(childEvents, "tool.error")[0]).toMatchObject({
      error: { code: "tool_unknown" },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fan-out review hardening (§5.1, the three-reviewer round). Each test names
// the finding it locks in: R1 = depth/budget/allowlist, R2 = abort/isolation,
// R3 = tool router filtering.
// ═══════════════════════════════════════════════════════════════════════════

/** Provider that streams each scripted chunk ~8ms apart (slow-stream tests). */
class SlowStreamProvider extends TaskDispatchProvider {
  protected chunkDelayMs = 8;

  override async *complete(req: Parameters<TaskDispatchProvider["complete"]>[0]) {
    for await (const chunk of super.complete(req)) {
      await new Promise((r) => setTimeout(r, this.chunkDelayMs));
      yield chunk;
    }
  }
}

describe("fan-out hardening — R1: budget arithmetic", () => {
  it("rejects negative, zero, and fractional spec budgets (no session, no allocation)", async () => {
    const h = await makeSubagentHarness();
    for (const bad of [-1_000_000, 0, 1024.5]) {
      await expect(
        h.manager.spawn({ task: "poison", budget_tokens: bad }, h.parentCtx, {
          session_id: h.parent.session_id,
          turn_id: "t1",
        }),
      ).rejects.toMatchObject({ code: "validation_failed" });
    }
    // Nothing was created and nothing was allocated.
    expect(turnSpendOf(h.manager as never)(h.parent.session_id, "t1")).toBe(0);
    expect(byType(await readAll(h, h.parent.session_id), "subagent.spawned")).toEqual([]);
  });

  it("a negative budget through the REAL runtime path dies as a tool error (model-facing closure)", async () => {
    const h = await makeSubagentHarness();
    h.manager.bindTurn(h.parent.session_id, "rt1", h.parentCtx);
    // The parent's script (fallback queue): a spawn call with a poisoned budget.
    h.provider.scriptParent([
      mockToolTurn({
        call_id: "c1",
        name: "spawn_subagent",
        input: { task: "x", budget_tokens: -1000000 },
      }),
      mockTextTurn("recovered"),
    ]);
    const events: SessionEvent[] = [];
    for await (const ev of createAgentLoop().run(
      {
        session_id: h.parent.session_id,
        turn_id: "rt1",
        user_message: { role: "user", content: [{ type: "text", text: "go" }] },
      },
      h.parentCtx,
    )) {
      events.push(ev);
    }
    // The runtime's compiled schema drops `minimum` (type+properties+required
    // only) — the handler's own check is what closes the path.
    const err = byType(events, "tool.error")[0]!;
    expect(err.error.message).toContain("1024");
    expect(byType(events, "subagent.spawned")).toEqual([]);
    expect(turnSpendOf(h.manager as never)(h.parent.session_id, "rt1")).toBe(0);
    // The parent turn itself recovered.
    expect(types(events)).toContain("turn.completed");
    h.manager.unbindTurn(h.parent.session_id);
  });
});

describe("fan-out hardening — R1/R2: post-create throws cannot zombie a child", () => {
  it("a loop that explodes before its own try/catch becomes state=failed, settled everywhere", async () => {
    const settled: Array<string> = [];
    const explodingLoop: AgentLoop = {
      // eslint-disable-next-line require-yield -- the point: it throws first
      async *run(): AsyncGenerator<SessionEvent> {
        throw new Error("child loop exploded");
      },
    };
    const h = await makeSubagentHarness({
      managerDeps: {
        loop: explodingLoop,
        onSettled: (id: string, state: string) => settled.push(`${id}:${state}`),
      },
    });
    const result = await h.manager.spawn({ task: "doomed" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });

    expect(result.state).toBe("failed");
    expect(result.error?.message).toContain("child loop exploded");
    // subagent.failed lands on BOTH logs — list() can never report "running".
    const parentEvents = await readAll(h, h.parent.session_id);
    expect(byType(parentEvents, "subagent.failed")[0]!.subagent_session_id).toBe(result.session_id);
    const childEvents = await readAll(h, result.session_id);
    expect(byType(childEvents, "subagent.failed")[0]!.subagent_session_id).toBe(result.session_id);
    expect(settled).toEqual([`${result.session_id}:failed`]);
    const infos = await h.manager.list(h.parent.session_id);
    expect(infos.map((i) => i.state)).toEqual(["failed"]);
    // Allocation stickiness: the failed child's budget stays counted
    // (conservative — over-counting denies, never overspends).
    expect(turnSpendOf(h.manager as never)(h.parent.session_id, "t1")).toBe(32_768);
  });
});

describe("fan-out hardening — R2: abort × approvals × poll liveness", () => {
  it("a child blocked on an ask-approval is unblocked by parent abort (withdraw, not TTL)", async () => {
    const presented: string[] = [];
    const withdrawn: string[] = [];
    const presenter: ApprovalPresenter = {
      id: "test-presenter",
      present: async (req) => {
        presented.push(req.approval_id);
      },
      withdraw: async (approval_id, reason) => {
        withdrawn.push(`${approval_id}:${reason}`);
      },
    };
    const h = await makeSubagentHarness({
      extraTools: [
        {
          name: "test.ask",
          risk: "R2", // no allow rule matches R2 → policy "ask"
          handler: { execute: async () => ({ kind: "text", text: "asked" }) },
        },
      ],
      managerDeps: {
        onSpawned: (child: { session_id: string }) => {
          (h.parentCtx.approvals as ApprovalEngineImpl).registerPresenter(
            child.session_id,
            presenter,
          );
        },
      },
    });
    h.provider.script("asker", [
      mockToolTurn({ call_id: "c1", name: "test.ask", input: {} }),
      mockTextTurn("done"),
    ]);

    const spawned = h.manager.spawn({ task: "asker", tools: ["test.ask"] }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
    // Let the child reach the approval wait (presented = blocked).
    await new Promise((r) => setTimeout(r, 120));
    expect(presented).toHaveLength(1);
    h.parentController.abort();
    const result = await spawned; // resolves via withdraw, not the 10-min TTL

    expect(result.state).toBe("aborted");
    expect(result.error).toMatchObject({ code: "aborted" });
    const parentEvents = await readAll(h, h.parent.session_id);
    expect(byType(parentEvents, "subagent.aborted")[0]!.reason).toBe("parent turn aborted");
    expect(withdrawn.length).toBe(1);
    expect(withdrawn[0]).toContain("parent turn aborted");
  });

  it("the cross-process poll is not starved by a continuously streaming child", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-stream-abort-"));
    const dbFile = path.join(dir, "nyx.db");
    const Database = (await import("better-sqlite3")).default;
    const mgrDb: Database.Database = new Database(dbFile);
    const cliDb: Database.Database = new Database(dbFile);
    // 40 chunks x 8ms ≈ 320ms of continuous streaming — event gaps stay far
    // below poll_ms, the exact regime that starved the old sleep-based poll.
    const stream: ModelChunk[] = [
      { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    ];
    for (let i = 0; i < 40; i++) stream.push({ type: "text.delta", text: `chunk ${i} ` });
    stream.push({ type: "done", finish_reason: "stop" });
    const provider = new SlowStreamProvider();
    const h = await makeSubagentHarness({
      provider,
      managerDeps: {
        db: mgrDb,
        poll_ms: 30,
        onSpawned: (child: { session_id: string }) =>
          requestSubagentAbort(cliDb, child.session_id, "cli:test"),
      },
    });
    h.provider.script("chatterbox", [stream]);

    const result = await h.manager.spawn({ task: "chatterbox" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
    // The abort row was written BEFORE the stream began; a non-starved poll
    // applies it mid-stream, so the terminal state is aborted — not the
    // completed turn the stream would otherwise produce.
    expect(result.state).toBe("aborted");
    expect(listSubagentAbortRequests(cliDb)).toEqual([]);
    mgrDb.close();
    cliDb.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("abort precedence: a parent abort racing a budget trip settles as aborted", async () => {
    const provider = new SlowStreamProvider();
    const h = await makeSubagentHarness({
      provider,
      config: { default_budget_tokens: 1024 },
    });
    // The budget trips on the FIRST chunk (~8ms); the parent aborts at 60ms —
    // both mid-stream, before the pump drains the terminal state.
    const stream: ModelChunk[] = [
      { type: "usage", usage: { input_tokens: 4000, output_tokens: 1000, total_tokens: 5000 } },
    ];
    for (let i = 0; i < 40; i++) stream.push({ type: "text.delta", text: `chunk ${i} ` });
    stream.push({ type: "done", finish_reason: "stop" });
    h.provider.script("burner", [stream]);

    const spawned = h.manager.spawn({ task: "burner" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
    setTimeout(() => h.parentController.abort(), 60);
    const result = await spawned;

    expect(result.state).toBe("aborted"); // parentAborted outranks budgetExceeded
    const parentEvents = await readAll(h, h.parent.session_id);
    expect(byType(parentEvents, "subagent.aborted")[0]!.reason).toBe("parent turn aborted");
  });

  it("abort rows are ownership-aware: stale rows die, rows for other processes survive", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-row-aware-"));
    const dbFile = path.join(dir, "nyx.db");
    const Database = (await import("better-sqlite3")).default;
    const mgrDb: Database.Database = new Database(dbFile);
    const cliDb: Database.Database = new Database(dbFile);
    const h = await makeSubagentHarness({
      extraTools: [
        {
          name: "test.linger",
          handler: {
            execute: () =>
              new Promise((r) => setTimeout(() => r({ kind: "text", text: "done" }), 80)),
          },
        },
      ],
      managerDeps: { db: mgrDb, poll_ms: 20 },
    });
    h.provider.script("drain-one", [
      mockToolTurn({ call_id: "c1", name: "test.linger", input: {} }),
      mockTextTurn("drain one done"),
    ]);

    // Three foreign rows: a SETTLED child (terminal event present), a
    // RUNNING-ELSEWHERE child (spawned, no terminal — another process owns
    // it), and a bogus id that matches no session at all.
    const settledChild = await h.store.create({
      owner_id: "test-owner",
      persona_id: "test-persona",
      parent_id: h.parent.session_id,
      kind: "subagent",
    });
    await h.store.append(settledChild.session_id, [
      {
        type: "subagent.completed",
        session_id: settledChild.session_id,
        subagent_session_id: settledChild.session_id,
        parent_session_id: h.parent.session_id,
        summary: "already done",
        tokens_used: 1,
        duration_ms: 1,
        ts: Date.now(),
      },
    ]);
    const elsewhereChild = await h.store.create({
      owner_id: "test-owner",
      persona_id: "test-persona",
      parent_id: h.parent.session_id,
      kind: "subagent",
    });
    await h.store.append(elsewhereChild.session_id, [
      {
        type: "subagent.spawned",
        session_id: elsewhereChild.session_id,
        subagent_session_id: elsewhereChild.session_id,
        turn_id: "sub-x",
        parent_session_id: h.parent.session_id,
        parent_turn_id: "t-x",
        task: "lives in another process",
        depth: 1,
        ts: Date.now(),
      },
    ]);
    requestSubagentAbort(cliDb, settledChild.session_id, "cli:test");
    requestSubagentAbort(cliDb, elsewhereChild.session_id, "cli:test");
    requestSubagentAbort(cliDb, "no-such-session", "cli:test");

    // The probe child runs ~80ms with poll_ms 20 → several drain passes.
    const probe = await h.manager.spawn(
      { task: "drain-one", tools: ["test.linger"] },
      h.parentCtx,
      {
        session_id: h.parent.session_id,
        turn_id: "t1",
      },
    );
    expect(probe.state).toBe("completed");

    const remaining = listSubagentAbortRequests(cliDb).map((r) => r.session_id);
    expect(remaining).toEqual([elsewhereChild.session_id]); // survived: not ours
    // Once the elsewhere child settles, a later drain cleans its row too.
    await h.store.append(elsewhereChild.session_id, [
      {
        type: "subagent.completed",
        session_id: elsewhereChild.session_id,
        subagent_session_id: elsewhereChild.session_id,
        parent_session_id: h.parent.session_id,
        summary: "finally done",
        tokens_used: 1,
        duration_ms: 1,
        ts: Date.now(),
      },
    ]);
    h.provider.script("drain-two", [
      mockToolTurn({ call_id: "c1", name: "test.linger", input: {} }),
      mockTextTurn("drain two done"),
    ]);
    await h.manager.spawn({ task: "drain-two", tools: ["test.linger"] }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t2",
    });
    expect(listSubagentAbortRequests(cliDb)).toEqual([]);
    mgrDb.close();
    cliDb.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe("fan-out hardening — R3: structural absence, proven harder", () => {
  it("spawn_subagent is absent even with forbidden_tools emptied (config-independence)", async () => {
    const h = await makeSubagentHarness({ config: { forbidden_tools: [] } });
    h.provider.script("recursive", [
      mockToolTurn({ call_id: "c1", name: "spawn_subagent", input: { task: "grandchild" } }),
      mockTextTurn("i could not spawn"),
    ]);
    const result = await h.manager.spawn(
      { task: "recursive", tools: ["spawn_subagent", "fs.read"] },
      h.parentCtx,
      { session_id: h.parent.session_id, turn_id: "t1" },
    );
    expect(result.state).toBe("completed");
    // The spec NAMED spawn_subagent and config forbids nothing — the child's
    // registry still lacks it (the hardcoded gate, not the config list).
    const childEvents = await readAll(h, result.session_id);
    expect(byType(childEvents, "tool.error")[0]).toMatchObject({
      error: { code: "tool_unknown" },
    });
    // …while the allowed tool really is there.
    const childCtx = h.capturedContexts.get(result.session_id)!;
    expect(childCtx.tools.list().map((d) => d.name)).toContain("fs.read");
    expect(childCtx.tools.list().map((d) => d.name)).not.toContain("spawn_subagent");
    // No grandchild was created: the only spawned event on the child's log is
    // the child's OWN (mirrored at its creation).
    const childSpawned = byType(childEvents, "subagent.spawned");
    expect(childSpawned).toHaveLength(1);
    expect(childSpawned[0]!.subagent_session_id).toBe(result.session_id);
  });

  it("the child's outgoing model request offers no spawn_subagent (catalog proof)", async () => {
    const h = await makeSubagentHarness();
    h.provider.script("catalog-probe", [mockTextTurn("ok")]);
    await h.manager.spawn({ task: "catalog-probe" }, h.parentCtx, {
      session_id: h.parent.session_id,
      turn_id: "t1",
    });
    const childRequest = h.provider.requests.find((r) =>
      r.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.some(
            (b) =>
              b.type === "text" && b.text.includes("You are a subagent. Your task: catalog-probe"),
          ),
      ),
    );
    expect(childRequest).toBeDefined();
    const names = (childRequest!.tools ?? []).map((t) => t.name);
    expect(names).not.toContain("spawn_subagent");
    expect(names).toEqual(
      expect.arrayContaining(["fs.read", "fs.write", "fs.list", "shell.exec", "web.fetch"]),
    );
  });

  it("a session that STARTS at max depth still lacks the tool, and depth is exhausted", async () => {
    const h = await makeSubagentHarness(); // max_depth 3
    // Build a depth-2 parent by hand (subagent of a subagent)…
    const s1 = await h.store.create({
      owner_id: "test-owner",
      persona_id: "test-persona",
      parent_id: h.parent.session_id,
      kind: "subagent",
    });
    const s2 = await h.store.create({
      owner_id: "test-owner",
      persona_id: "test-persona",
      parent_id: s1.session_id,
      kind: "subagent",
    });
    // …so this spawn creates a depth-3 child (the configured maximum).
    h.provider.script("deepest", [
      mockToolTurn({ call_id: "c1", name: "spawn_subagent", input: { task: "grandchild" } }),
      mockTextTurn("no tool to call"),
    ]);
    const result = await h.manager.spawn({ task: "deepest" }, h.parentCtx, {
      session_id: s2.session_id,
      turn_id: "t1",
    });
    expect(result.state).toBe("completed");
    const spawnedEvent = byType(await readAll(h, s2.session_id), "subagent.spawned")[0]!;
    expect(spawnedEvent.depth).toBe(3);
    // Hard rule #7: the depth-3 child still cannot SEE the tool.
    const childEvents = await readAll(h, result.session_id);
    expect(byType(childEvents, "tool.error")[0]).toMatchObject({
      error: { code: "tool_unknown" },
    });
    // And the lineage is exhausted: spawning FROM the depth-3 child rejects.
    expect(await h.manager.depth_for(result.session_id)).toBe(0);
    h.provider.script("one-too-many", [mockTextTurn("never")]);
    await expect(
      h.manager.spawn({ task: "one-too-many" }, h.parentCtx, {
        session_id: result.session_id,
        turn_id: "t1",
      }),
    ).rejects.toMatchObject({ code: "depth_exceeded" });
  });
});

describe("fan-out hardening — R2: memory view edges", () => {
  it("get() ownership-filters; list() over-fetches past other children's rows", async () => {
    const h = await makeSubagentHarness();
    const parentEntry = await h.memory.write({
      scope: "session",
      kind: "fact",
      content: "parent secret",
      tags: [],
      source: { session_id: h.parent.session_id },
    });
    const viewA = new SubagentMemory(h.memory, "child-A");
    const viewB = new SubagentMemory(h.memory, "child-B");
    const own: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await viewA.write({
        scope: "session",
        kind: "episode",
        content: `A note ${i}`,
        tags: [],
        source: { session_id: "child-A" },
      });
      own.push(e.id);
    }
    for (let i = 0; i < 5; i++) {
      await viewB.write({
        scope: "session",
        kind: "episode",
        content: `B note ${i}`,
        tags: [],
        source: { session_id: "child-B" },
      });
    }

    // get(): own id yes, another child's id no, parent's session-scope id no.
    expect((await viewA.get(own[0]!))?.content).toBe("A note 0");
    const bEntries = await viewB.list({ limit: 50 });
    expect(await viewA.get(bEntries[0]!.id)).toBeNull();
    expect(await viewA.get(parentEntry.id)).toBeNull();

    // list(): 5 foreign subagent rows exist, but A still gets its full 3.
    expect((await viewA.list({ limit: 3 })).map((e) => e.content)).toHaveLength(3);
    expect((await viewA.list()).map((e) => e.content).every((c) => c.startsWith("A note"))).toBe(
      true,
    );
    expect(await viewA.list()).toHaveLength(5);
    // …and none of A's queries ever surface the parent's session row.
    expect((await viewA.list()).map((e) => e.content)).not.toContain("parent secret");
  });
});
