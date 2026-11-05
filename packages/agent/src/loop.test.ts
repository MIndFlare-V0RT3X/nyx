// SPDX-License-Identifier: AGPL-3.0-or-later
// The agent loop e2e suite: real session store, real model router over a
// scripted mock provider, real approval engine — hand-rolled kernel, sandbox,
// memory store, and tool runtime from the shared harness. Each test drives
// the loop through its public run() iterator and asserts the durable event
// sequence, the store-first invariant, and the model-facing request shapes.

import { afterAll, describe, expect, it } from "vitest";
import { SECTION_ORDER } from "@nyx/protocol";
import type {
  ContentBlock,
  Message,
  ModelChunk,
  RunInput,
  SessionEvent,
  StoredEvent,
  ToolDefinition,
} from "@nyx/protocol";
import { mockFailTurn, mockTextAndToolTurn, mockTextTurn, mockToolTurn } from "@nyx/model";
import { AgentError } from "./errors.js";
import { closeAllHarnesses, makeHarness } from "./harness.test.js";

afterAll(closeAllHarnesses);

const types = (events: SessionEvent[]): string[] => events.map((e) => e.type);

const byType = <T extends SessionEvent["type"]>(
  events: SessionEvent[],
  type: T,
): Array<Extract<SessionEvent, { type: T }>> =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

/** Drops the store-assigned seq so stored events compare equal to yielded ones. */
const stripSeq = (e: StoredEvent): SessionEvent => {
  const { seq: _seq, ...rest } = e;
  return rest as SessionEvent;
};

/** Finds the model-facing tool_result block for a call id in a request. */
function toolResultBlockOf(
  messages: Message[],
  callId: string,
): Extract<ContentBlock, { type: "tool_result" }> {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result" && block.call_id === callId) return block;
    }
  }
  throw new Error(`no tool_result block for ${callId}`);
}

const TOOL_ROUND_SCRIPT = [
  mockTextAndToolTurn("Reading the file.", {
    call_id: "c1",
    name: "fs.read",
    input: { path: "x.txt" },
  }),
  mockTextTurn("done"),
];

describe("agent loop", () => {
  describe("a full tool round", () => {
    it("yields the exact durable event sequence with correct payloads", async () => {
      const h = await makeHarness({ script: [...TOOL_ROUND_SCRIPT] });
      h.runtimeSpy.setHandler(async () => ({ kind: "text", text: "file body" }));

      const events = await h.run();

      expect(types(events)).toEqual([
        "turn.started",
        "message.user",
        "text.delta",
        "text.delta",
        "message.assistant",
        "tool.call",
        "tool.result",
        "text.delta",
        "text.delta",
        "message.assistant",
        "turn.completed",
      ]);

      expect(events[0]).toMatchObject({ type: "turn.started", turn_id: "t1" });
      expect(events[1]).toMatchObject({
        type: "message.user",
        content: [{ type: "text", text: "please continue" }],
      });

      const assistants = byType(events, "message.assistant");
      expect(assistants[0]!.content).toEqual([
        { type: "text", text: "Reading the file." },
        { type: "tool_use", call_id: "c1", name: "fs.read", input: { path: "x.txt" } },
      ]);
      expect(assistants[1]!.content).toEqual([{ type: "text", text: "done" }]);

      expect(byType(events, "tool.call")[0]).toMatchObject({
        call_id: "c1",
        name: "fs.read",
        input: { path: "x.txt" },
      });
      // the durable tool.result carries the RAW output; wrapping is model-facing only
      expect(byType(events, "tool.result")[0]).toMatchObject({
        call_id: "c1",
        output: { kind: "text", text: "file body" },
      });

      // usage accumulated across both model calls: ceil(17/4) + ceil(4/4) = 5 + 1
      expect(byType(events, "turn.completed")[0]!.usage).toEqual({
        input_tokens: 0,
        output_tokens: 6,
        total_tokens: 6,
      });
    });

    it("yields every text.delta before the assistant message it composes", async () => {
      const h = await makeHarness({ script: [...TOOL_ROUND_SCRIPT] });

      const events = await h.run();

      let pending = "";
      let assistantMessagesWithText = 0;
      for (const event of events) {
        if (event.type === "text.delta") {
          pending += event.text;
        } else if (event.type === "message.assistant") {
          const text = event.content.find(
            (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
          )?.text;
          if (text !== undefined) {
            assistantMessagesWithText += 1;
            expect(pending.endsWith(text)).toBe(true);
            pending = "";
          }
        }
      }
      expect(assistantMessagesWithText).toBe(2);
      expect(pending).toBe("");
    });

    it("records the same sequence durably: read-back matches the iterator", async () => {
      const h = await makeHarness({ script: [...TOOL_ROUND_SCRIPT] });

      const events = await h.run();

      const stored = await h.store.read(h.session.session_id, 1);
      expect(types(stored)).toEqual(["session.created", ...types(events)]);
      expect(stored.slice(1).map(stripSeq)).toEqual(events);
      // this turn never produced approval lifecycle events
      expect(types(stored).filter((t) => t.startsWith("approval."))).toEqual([]);
    });
  });

  describe("the store-first invariant", () => {
    it("appends every event to the store before yielding it", async () => {
      const h = await makeHarness({ script: [...TOOL_ROUND_SCRIPT] });
      h.runtimeSpy.setHandler(async () => ({ kind: "text", text: "file body" }));

      let storedCount = (await h.store.read(h.session.session_id)).length; // session.created
      let yielded = 0;
      for await (const event of h.loop.run(h.input(), h.ctx)) {
        yielded += 1;
        const stored = await h.store.read(h.session.session_id);
        // the moment the consumer sees the event, the store already has it
        expect(stored).toHaveLength(storedCount + 1);
        storedCount = stored.length;
        expect(stripSeq(stored[stored.length - 1]!)).toEqual(event);
      }
      expect(yielded).toBe(11);
    });
  });

  describe("system prompt shape", () => {
    it("sends one system message per section in SECTION_ORDER, then history, then the user message", async () => {
      const h = await makeHarness({
        script: [mockTextTurn("first answer"), mockTextTurn("second answer")],
      });
      await h.run(h.input("t1", "first question"));
      await h.run(h.input("t2", "second question"));

      expect(h.provider.calls).toBe(2);

      // first turn: 8 section messages + the user message, nothing else
      const first = h.provider.requests[0]!;
      expect(first.messages).toHaveLength(SECTION_ORDER.length + 1);
      const sections = first.messages.slice(0, SECTION_ORDER.length);
      expect(sections.every((m) => m.role === "system")).toBe(true);
      for (let i = 0; i < SECTION_ORDER.length; i++) {
        const id = SECTION_ORDER[i]!;
        // sectionMessage() renders "title\n\nbody" as a single text block
        expect(sections[i]!.content).toEqual([
          { type: "text", text: `${id}\n\n${id} body; 0 tools` },
        ]);
      }
      expect(first.messages[SECTION_ORDER.length]).toEqual({
        role: "user",
        content: [{ type: "text", text: "first question" }],
      });

      // second turn: sections + prior history + the new user message last
      const second = h.provider.requests[1]!;
      expect(second.messages).toHaveLength(SECTION_ORDER.length + 3);
      expect(second.messages[8]).toEqual({
        role: "user",
        content: [{ type: "text", text: "first question" }],
      });
      expect(second.messages[9]).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
      });
      expect(second.messages[10]).toEqual({
        role: "user",
        content: [{ type: "text", text: "second question" }],
      });

      // the router substituted the chain's model; no tools registered → none offered
      expect(second.model).toBe("mock-1");
      expect(second.tools).toEqual([]);
    });

    it("builds the memory catalog WITHOUT the subagent scope (parent never sees child memory)", async () => {
      // Hard rule #3, fan-out review R2: subagent-scope rows belong to child
      // sessions; the parent must learn a child's results from the
      // SubagentResult, never from memory. The catalog query must exclude
      // the "subagent" scope structurally.
      const h = await makeHarness({
        script: [mockTextTurn("ok")],
        memories: [
          {
            scope: "session",
            kind: "fact",
            content: "parent session fact",
            tags: [],
            source: { session_id: "s1" },
          },
          {
            scope: "subagent",
            kind: "episode",
            content: "child secret summary",
            tags: [],
            source: { session_id: "child-1" },
          },
          {
            scope: "global",
            kind: "fact",
            content: "global fact",
            tags: [],
            source: {},
          },
        ],
      });
      await h.run();

      // The catalog query names its scopes — and "subagent" is not among them.
      expect(h.memory.listCalls.length).toBeGreaterThan(0);
      for (const scopes of h.memory.listCalls) {
        expect(scopes).toBeDefined();
        expect(scopes!).not.toContain("subagent");
      }
      // Functionally: with the store honoring the scope filter, the catalog
      // the persona received cannot contain the child's row.
      const catalogRows = await h.memory.list({ scope: h.memory.listCalls[0], limit: 50 });
      expect(catalogRows.map((m) => m.content)).toEqual(
        expect.arrayContaining(["parent session fact", "global fact"]),
      );
      expect(catalogRows.map((m) => m.content)).not.toContain("child secret summary");
    });
  });

  describe("error recovery", () => {
    it("allows exactly one retry per turn: the second failure bypasses the hook and the model is never called a third time", async () => {
      let recoverHookCalls = 0;
      const h = await makeHarness({
        script: [mockFailTurn(new Error("boom 1")), mockFailTurn(new Error("boom 2"))],
      });
      h.kernel.hooks.on("feedback.recover", async () => {
        recoverHookCalls += 1;
        return { strategy: "retry", note: "transient" };
      });

      const events = await h.run();

      expect(types(events)).toEqual(["turn.started", "message.user", "turn.failed"]);
      const failed = byType(events, "turn.failed")[0]!;
      expect(failed.error.message).toBe("boom 2");
      expect(failed.error.code).toBe("provider_error");
      expect(recoverHookCalls).toBe(1);
      expect(h.kernel.hooks.emissions.get("feedback.recover")).toBe(1);
      expect(h.provider.calls).toBe(2);
    });

    it("with no recovery hook registered, a single failure fails the turn immediately", async () => {
      const h = await makeHarness({ script: [mockFailTurn(new Error("boom 1"))] });

      const events = await h.run();

      expect(types(events)).toEqual(["turn.started", "message.user", "turn.failed"]);
      expect(byType(events, "turn.failed")[0]!.error.message).toBe("boom 1");
      // the loop still consulted the hook point once; nobody answered
      expect(h.kernel.hooks.emissions.get("feedback.recover")).toBe(1);
      expect(h.provider.calls).toBe(1);
    });

    it("retries once on a retry hint, injecting the recovery hint system message into the retry request", async () => {
      const h = await makeHarness({
        script: [mockFailTurn(new Error("transient network blip")), mockTextTurn("recovered")],
      });
      h.kernel.hooks.on("feedback.recover", async () => ({
        strategy: "retry",
        note: "transient",
      }));

      const events = await h.run();

      expect(types(events)).toEqual([
        "turn.started",
        "message.user",
        "text.delta",
        "text.delta",
        "message.assistant",
        "turn.completed",
      ]);
      expect(h.provider.calls).toBe(2);

      const retry = h.provider.requests[1]!;
      const last = retry.messages[retry.messages.length - 1]!;
      expect(last.role).toBe("system");
      expect(last.content).toEqual([{ type: "text", text: "recovery hint: transient" }]);

      // the failed attempt left no assistant message on the record
      const assistants = byType(events, "message.assistant");
      expect(assistants).toHaveLength(1);
      expect(assistants[0]!.content).toEqual([{ type: "text", text: "recovered" }]);
    });

    it("aborts immediately on an abort hint: no second model call", async () => {
      let recoverHookCalls = 0;
      const h = await makeHarness({
        script: [mockFailTurn(new Error("hard failure")), mockTextTurn("never")],
      });
      h.kernel.hooks.on("feedback.recover", async () => {
        recoverHookCalls += 1;
        return { strategy: "abort", note: "give up" };
      });

      const events = await h.run();

      expect(types(events)).toEqual(["turn.started", "message.user", "turn.failed"]);
      expect(recoverHookCalls).toBe(1);
      expect(h.provider.calls).toBe(1);
      expect(byType(events, "turn.failed")[0]!.error.message).toBe("hard failure");
    });

    it("treats a stream ending with finish_reason error as a thrown failure (recovery applies)", async () => {
      const h = await makeHarness({
        script: [
          [
            { type: "text.delta", text: "partial" },
            { type: "done", finish_reason: "error" },
          ],
          mockTextTurn("fine"),
        ],
      });
      h.kernel.hooks.on("feedback.recover", async () => ({ strategy: "retry", note: "glitch" }));

      const events = await h.run();

      expect(types(events)).toContain("turn.completed");
      expect(h.provider.calls).toBe(2);
    });

    it("fails the turn on finish_reason error when no retry is offered", async () => {
      const h = await makeHarness({
        script: [
          [
            { type: "text.delta", text: "partial" },
            { type: "done", finish_reason: "error" },
          ],
        ],
      });

      const events = await h.run();

      expect(types(events)).toEqual(["turn.started", "message.user", "text.delta", "turn.failed"]);
      const failed = byType(events, "turn.failed")[0]!;
      expect(failed.error.name).toBe("AgentError");
      expect(failed.error.code).toBe("provider_error");
      expect(failed.error.message).toContain("error");
      expect(h.provider.calls).toBe(1);
    });
  });

  describe("compaction", () => {
    it("emits compaction events and elides tool_result outputs from history when the estimate exceeds the budget", async () => {
      const h = await makeHarness({
        script: [mockTextTurn("ok")],
        options: { compaction_budget_tokens: 8_000 },
      });

      // Seed a prior turn whose history carries a tool_result block. The
      // session projection materializes only message.user/message.assistant
      // events into history messages, so the seed carries the tool result as
      // assistant message content.
      const sid = h.session.session_id;
      await h.store.append(sid, [
        { type: "turn.started", session_id: sid, turn_id: "t-seed", ts: 1 },
        {
          type: "message.user",
          session_id: sid,
          turn_id: "t-seed",
          content: [{ type: "text", text: "read x.txt" }],
          ts: 2,
        },
        {
          type: "message.assistant",
          session_id: sid,
          turn_id: "t-seed",
          content: [
            { type: "tool_use", call_id: "old-1", name: "fs.read", input: { path: "x.txt" } },
          ],
          ts: 3,
        },
        {
          type: "message.assistant",
          session_id: sid,
          turn_id: "t-seed",
          content: [
            {
              type: "tool_result",
              call_id: "old-1",
              output: {
                kind: "text",
                // ~55KB ≈ 13k tokens: far over the 5k elision threshold and
                // over the budget, so Tier 1 fires; after elision the context
                // is far under 95% of the budget, so Tier 4 stays out.
                text: `<tool_output trust="untrusted">\n${"pretend file body\n".repeat(3600)}</tool_output>`,
              },
            },
          ],
          ts: 4,
        },
        {
          type: "turn.completed",
          session_id: sid,
          turn_id: "t-seed",
          usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
          ts: 5,
        },
      ]);

      const events = await h.run(h.input("t1", "again please"));

      expect(types(events)).toEqual([
        "turn.started",
        "message.user",
        "compaction.started",
        "compaction.completed",
        "text.delta",
        "text.delta",
        "message.assistant",
        "turn.completed",
      ]);
      expect(byType(events, "compaction.started")[0]).toMatchObject({ strategy: "rule-elision" });
      const completed = byType(events, "compaction.completed")[0]!;
      expect(completed.strategy).toBe("rule-elision");
      expect(completed.freed_tokens).toBeGreaterThan(0);

      // the next model request carries the elision marker, not the tool output
      const request = h.provider.requests[0]!;
      const serialized = JSON.stringify(request.messages);
      expect(serialized).toContain("[elided tool output old-1]");
      expect(serialized).not.toContain("pretend file body");
      // system sections are structurally immune to elision
      expect(request.messages.filter((m) => m.role === "system")).toHaveLength(
        SECTION_ORDER.length,
      );
    });
  });

  describe("max_tool_rounds", () => {
    it("caps dispatch rounds and completes the turn without dispatching further calls", async () => {
      const h = await makeHarness({
        script: [
          mockToolTurn({ call_id: "c1", name: "fs.read", input: { path: "a.txt" } }),
          mockToolTurn({ call_id: "c2", name: "fs.read", input: { path: "b.txt" } }),
          mockToolTurn({ call_id: "c3", name: "fs.read", input: { path: "c.txt" } }),
          mockToolTurn({ call_id: "c4", name: "fs.read", input: { path: "d.txt" } }),
          mockToolTurn({ call_id: "c5", name: "fs.read", input: { path: "e.txt" } }),
          mockTextTurn("done"),
        ],
        options: { max_tool_rounds: 2 },
      });

      const events = await h.run();

      expect(types(events)).toEqual([
        "turn.started",
        "message.user",
        "message.assistant",
        "tool.call",
        "tool.result",
        "message.assistant",
        "tool.call",
        "tool.result",
        "message.assistant",
        "turn.completed",
      ]);
      expect(h.runtimeSpy.calls).toHaveLength(2);
      expect(h.runtimeSpy.calls.map((c) => c.call.call_id)).toEqual(["c1", "c2"]);
      // two dispatched rounds + the round that hits the cap (never dispatched)
      expect(h.provider.calls).toBe(3);
    });
  });

  describe("action.before decisions", () => {
    it("a veto denies the action without executing it and keeps the turn going", async () => {
      const h = await makeHarness({
        script: [
          mockToolTurn({ call_id: "c1", name: "fs.read", input: { path: "x.txt" } }),
          mockTextTurn("ok"),
        ],
      });
      let afterHookCalls = 0;
      h.kernel.hooks.on("action.before", async () => ({ kind: "veto", reason: "not allowed" }));
      h.kernel.hooks.on("action.after", async () => {
        afterHookCalls += 1;
      });

      const events = await h.run();

      expect(types(events)).toEqual([
        "turn.started",
        "message.user",
        "message.assistant",
        "action.denied",
        "text.delta",
        "text.delta",
        "message.assistant",
        "turn.completed",
      ]);
      expect(byType(events, "action.denied")[0]).toMatchObject({
        call_id: "c1",
        reason: "policy",
        detail: "vetoed by hook: not allowed",
      });
      expect(h.runtimeSpy.calls).toHaveLength(0);
      expect(afterHookCalls).toBe(0);

      // the model-facing tool_result explains the denial inside untrusted markers
      const denial = toolResultBlockOf(h.provider.requests[1]!.messages, "c1");
      expect(denial.output).toEqual({
        kind: "text",
        text: '<tool_output trust="untrusted">\naction denied: vetoed by hook: not allowed\n</tool_output>',
      });
    });

    it("an ask decision forwards force_ask to the tool runtime", async () => {
      const h = await makeHarness({
        script: [
          mockToolTurn({ call_id: "c1", name: "fs.read", input: { path: "x.txt" } }),
          mockTextTurn("ok"),
        ],
      });
      h.kernel.hooks.on("action.before", async () => ({ kind: "ask", summary: "needs a human" }));

      const events = await h.run();

      expect(types(events)).toContain("tool.result");
      expect(h.runtimeSpy.calls).toHaveLength(1);
      expect(h.runtimeSpy.calls[0]!.opts).toEqual({ force_ask: true });
      expect(h.runtimeSpy.calls[0]!.call).toEqual({
        call_id: "c1",
        name: "fs.read",
        input: { path: "x.txt" },
      });
    });
  });

  describe("abort and typed startup failures", () => {
    it("a pre-aborted signal fails the turn before any model call", async () => {
      const controller = new AbortController();
      controller.abort();
      const h = await makeHarness({ script: [mockTextTurn("never")], signal: controller.signal });

      const events = await h.run();

      expect(types(events)).toEqual(["turn.failed"]);
      const failed = byType(events, "turn.failed")[0]!;
      expect(failed.error).toMatchObject({ name: "AbortError", code: "aborted" });
      expect(failed.error.message).toContain("aborted before start");
      expect(h.provider.calls).toBe(0);

      // the failure is still durable
      const stored = await h.store.read(h.session.session_id, 1);
      expect(types(stored)).toEqual(["session.created", "turn.failed"]);
    });

    it("throws a typed not_implemented error when no tools.runtime service is registered", async () => {
      const h = await makeHarness({ script: [mockTextTurn("never")], registerRuntime: false });

      const outcome = h.run();
      await expect(outcome).rejects.toBeInstanceOf(AgentError);
      await expect(outcome).rejects.toMatchObject({ code: "not_implemented" });
      await expect(outcome).rejects.toMatchObject({
        message: expect.stringContaining("tools.runtime"),
      });

      // nothing was appended: the failure predates the turn
      const stored = await h.store.read(h.session.session_id, 1);
      expect(types(stored)).toEqual(["session.created"]);
    });

    it("throws a typed not_found error for an unknown session (no events)", async () => {
      const h = await makeHarness({ script: [mockTextTurn("never")] });
      const input: RunInput = {
        session_id: "does-not-exist",
        turn_id: "t1",
        user_message: { role: "user", content: [{ type: "text", text: "hi" }] },
      };

      const outcome = h.run(input);
      await expect(outcome).rejects.toBeInstanceOf(AgentError);
      await expect(outcome).rejects.toMatchObject({ code: "not_found" });

      const stored = await h.store.read(h.session.session_id, 1);
      expect(types(stored)).toEqual(["session.created"]);
    });
  });
});

describe("parallel-round dispatch (Phase 3 §2.3)", () => {
  const parallelDef = (name: string): ToolDefinition => ({
    name,
    description: "parallel test tool",
    input_schema: { type: "object" },
    risk: "R0",
    capabilities: [],
    handler: `builtin:${name}`,
    concurrency: "parallel",
  });

  const twoParallelCalls: ModelChunk[] = [
    { type: "tool_call.delta", index: 0, id: "c1", name: "spawn.x", arguments_delta: '{"n":1}' },
    { type: "tool_call.delta", index: 1, id: "c2", name: "spawn.x", arguments_delta: '{"n":2}' },
    { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    { type: "done", finish_reason: "tool_calls" },
  ];

  it("runs every call of an all-parallel round concurrently, results in call order", async () => {
    const h = await makeHarness({
      script: [twoParallelCalls, mockTextTurn("done")],
      tools: [parallelDef("spawn.x")],
    });
    const timing: Record<string, { start: number; end: number }> = {};
    h.runtimeSpy.setHandler(async (call) => {
      const n = (call.input as { n: number }).n;
      timing[call.call_id] = { start: Date.now(), end: NaN };
      await new Promise((r) => setTimeout(r, n === 1 ? 60 : 10));
      timing[call.call_id]!.end = Date.now();
      return { kind: "text", text: `out-${n}` };
    });

    const events = await h.run();

    // Overlap proof: call 2 (10ms) finished BEFORE call 1 (60ms) ended —
    // impossible under sequential dispatch.
    expect(timing.c2!.end).toBeLessThan(timing.c1!.end);
    expect(timing.c2!.start).toBeLessThan(timing.c1!.end);

    // Both tool.call events precede both tool.result events; c2's result
    // lands before c1's (it finished first).
    const toolCalls = byType(events, "tool.call");
    const toolResults = byType(events, "tool.result");
    expect(toolCalls.map((e) => e.call_id)).toEqual(["c1", "c2"]);
    expect(toolResults.map((e) => e.call_id)).toEqual(["c2", "c1"]);
    const lastCallIdx = Math.max(...toolCalls.map((e) => events.indexOf(e)));
    const firstResultIdx = Math.min(...toolResults.map((e) => events.indexOf(e)));
    expect(lastCallIdx).toBeLessThan(firstResultIdx);

    // The model still receives the results in CALL order (c1, c2) — the
    // parallelism is execution, not presentation. (Outputs carry the
    // standard untrusted-data framing.)
    const final = h.provider.requests[h.provider.requests.length - 1]!;
    expect(toolResultBlockOf(final.messages, "c1").output).toMatchObject({
      kind: "text",
    });
    expect((toolResultBlockOf(final.messages, "c1").output as { text: string }).text).toContain(
      "out-1",
    );
    const order = final.messages
      .flatMap((m) => m.content)
      .filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result")
      .map((b) => b.call_id);
    expect(order).toEqual(["c1", "c2"]);

    expect(types(events).filter((t) => t === "tool.error")).toEqual([]);
    expect(events[events.length - 1]!.type).toBe("turn.completed");
  });

  it("keeps rounds with any serial-classified call strictly sequential", async () => {
    const serialDef: ToolDefinition = {
      name: "serial.x",
      description: "serial test tool",
      input_schema: { type: "object" },
      risk: "R0",
      capabilities: [],
      handler: "builtin:serial.x",
    };
    const mixedRound: ModelChunk[] = [
      { type: "tool_call.delta", index: 0, id: "c1", name: "spawn.x", arguments_delta: '{"n":1}' },
      { type: "tool_call.delta", index: 1, id: "c2", name: "serial.x", arguments_delta: '{"n":2}' },
      { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      { type: "done", finish_reason: "tool_calls" },
    ];
    const h = await makeHarness({
      script: [mixedRound, mockTextTurn("done")],
      tools: [parallelDef("spawn.x"), serialDef],
    });
    const timing: Record<string, { start: number; end: number }> = {};
    h.runtimeSpy.setHandler(async (call) => {
      const n = (call.input as { n: number }).n;
      timing[call.call_id] = { start: Date.now(), end: NaN };
      await new Promise((r) => setTimeout(r, n === 1 ? 60 : 5));
      timing[call.call_id]!.end = Date.now();
      return { kind: "text", text: "ok" };
    });
    await h.run();
    // c2 only started after c1 finished — the round stayed sequential.
    expect(timing.c2!.start).toBeGreaterThanOrEqual(timing.c1!.end);
  });
});
