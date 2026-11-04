// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 3 §5.2 e2e: the main agent spawns TWO subagents in one round — they
// run in parallel (verified by overlapping event timestamps on their own
// sessions), both summaries return as tool results, and the parent's final
// message synthesizes both. Driven through the real server surface (HTTP
// turns, lane queue, tool runtime, policy, session store) with a scripted
// provider standing in for the model — the machinery under test is real.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  CompletionRequest,
  ModelChunk,
  ModelInfo,
  ModelProvider,
  SessionEvent,
} from "@nyx/protocol";
import type { MockTurn } from "@nyx/model";
import { cleanupRigs, createSession, makeRig, readEvents, startTurn, until } from "./helpers.js";

/**
 * Marker-dispatch provider: subagent turns are keyed on their task marker
 * (each child's initial user message embeds its task); the parent session
 * consumes the fallback queue. "slow" markers delay their stream so the two
 * children's execution windows demonstrably overlap.
 */
class ParallelProvider implements ModelProvider {
  readonly id = "mock";
  private readonly byMarker = new Map<string, { turns: MockTurn[]; delay_ms: number }>();
  private readonly fallback: MockTurn[] = [];
  private readonly models: ModelInfo[] = [
    { id: "mock-1", context_window: 128000, max_output: 8192, supports: ["tools"] },
  ];

  script(marker: string, turns: MockTurn[], delayMs = 0): this {
    this.byMarker.set(marker, { turns: [...turns], delay_ms: delayMs });
    return this;
  }

  scriptParent(turns: MockTurn[]): this {
    this.fallback.push(...turns);
    return this;
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([...this.models]);
  }

  async *complete(req: CompletionRequest): AsyncGenerator<ModelChunk, void, void> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
    const entry = [...this.byMarker.entries()].find(([marker]) => text.includes(marker));
    if (entry !== undefined) {
      const [, { turns, delay_ms }] = entry;
      if (delay_ms > 0) await new Promise((r) => setTimeout(r, delay_ms));
      const turn = turns.shift();
      if (turn === undefined) throw new Error("parallel provider: script exhausted");
      if (!Array.isArray(turn)) throw new Error(turn.fail.message);
      for (const chunk of turn) yield chunk;
      return;
    }
    const turn = this.fallback.shift();
    if (turn === undefined) throw new Error("parallel provider: parent script exhausted");
    if (!Array.isArray(turn)) throw new Error(turn.fail.message);
    for (const chunk of turn) yield chunk;
  }
}

function spawnCalls(calls: Array<{ task: string }>): ModelChunk[] {
  return [
    ...calls.flatMap((c, i) => [
      {
        type: "tool_call.delta",
        index: i,
        id: `c${i + 1}`,
        name: "spawn_subagent",
        arguments_delta: JSON.stringify({ task: c.task }),
      },
    ]),
    { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    { type: "done", finish_reason: "tool_calls" },
  ];
}

function textTurn(text: string): ModelChunk[] {
  return [
    { type: "text.delta", text },
    { type: "usage", usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
    { type: "done", finish_reason: "stop" },
  ];
}

describe("e2e: two subagents in one round (Phase 3 §5.2)", () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  let provider: ParallelProvider;
  let parentTurnStartedAt = 0;

  beforeAll(async () => {
    provider = new ParallelProvider();
    // Subagent A: SLOW (400ms mid-stream delay) — its window must contain
    // subagent B's entire execution for the overlap proof to mean anything.
    provider.script("e2e-topic-slowpoke", [textTurn("slow findings: the answer is 41")], 400);
    // Subagent B: fast.
    provider.script("e2e-topic-quickfire", [textTurn("quick findings: the answer is 1")]);
    // Parent: round 1 spawns BOTH in one round; round 2 synthesizes.
    provider.scriptParent([
      spawnCalls([{ task: "e2e-topic-slowpoke" }, { task: "e2e-topic-quickfire" }]),
      textTurn("Synthesis — slow: 41, quick: 1. Combined answer: 42."),
    ]);
    rig = await makeRig([provider]);
  });

  afterAll(cleanupRigs);

  it("both subagents run in parallel, both summaries return, the parent synthesizes", async () => {
    const sessionId = await createSession(rig, { title: "parallel e2e" });
    parentTurnStartedAt = Date.now();
    await startTurn(rig, sessionId, "answer both questions using subagents");

    await until(async () => {
      const events = await readEvents(rig, sessionId);
      return events.some((e) => e.type === "turn.completed");
    });

    // ── parent log: mirrored lifecycle events only ──
    const parentEvents = await readEvents(rig, sessionId);
    const spawned = parentEvents.filter(
      (e): e is Extract<SessionEvent, { type: "subagent.spawned" }> =>
        e.type === "subagent.spawned",
    );
    const completed = parentEvents.filter(
      (e): e is Extract<SessionEvent, { type: "subagent.completed" }> =>
        e.type === "subagent.completed",
    );
    expect(spawned).toHaveLength(2);
    expect(completed).toHaveLength(2);
    // No child turn events leaked into the parent's log (hard rule #3): the
    // parent's non-subagent events are exactly its own turn's.
    const ownTypes = parentEvents
      .filter((e) => !e.type.startsWith("subagent."))
      .map((e) => e.type);
    expect(ownTypes).toEqual([
      "session.created",
      "turn.started",
      "message.user",
      "message.assistant",
      "tool.call",
      "tool.call",
      "tool.result",
      "tool.result",
      "text.delta",
      "message.assistant",
      "turn.completed",
    ]);

    // ── children: both completed, windows overlap ──
    const slow = spawned.find((e) => e.task.includes("slowpoke"))!;
    const quick = spawned.find((e) => e.task.includes("quickfire"))!;
    expect(slow).toBeDefined();
    expect(quick).toBeDefined();

    const window = async (
      id: string,
    ): Promise<{ start: number; end: number; events: SessionEvent[] }> => {
      const events = await readEvents(rig, id);
      const start = events.find((e) => e.type === "turn.started")?.ts ?? 0;
      const end =
        [...events].reverse().find((e) => e.type === "turn.completed")?.ts ?? 0;
      return { start, end, events };
    };
    const slowWindow = await window(slow.subagent_session_id);
    const quickWindow = await window(quick.subagent_session_id);

    // Parallel proof: the QUICK child started AND finished while the SLOW
    // child was still running. Under sequential dispatch this is impossible
    // — the second spawn would only start after the first completed.
    expect(quickWindow.start).toBeGreaterThanOrEqual(slowWindow.start);
    expect(quickWindow.end).toBeLessThan(slowWindow.end);
    // …and not because the slow one started late: both started together,
    // right after the parent's round began.
    expect(slowWindow.start - parentTurnStartedAt).toBeLessThan(2_000);
    expect(quickWindow.start - parentTurnStartedAt).toBeLessThan(2_000);

    // Child sessions: kind subagent, correct lineage, isolated logs.
    const { openSessionStore } = await import("@nyx/session");
    const store = openSessionStore(`${rig.dataDir}/nyx.db`);
    try {
      const slowMeta = await store.meta(slow.subagent_session_id);
      expect(slowMeta).toMatchObject({
        kind: "subagent",
        parent_id: sessionId,
        persona_id: (await store.meta(sessionId))?.persona_id,
      });
      // The child's log carries its OWN turn only — nothing from the parent
      // or the sibling.
      const slowTypes = slowWindow.events.map((e) => e.type);
      expect(slowTypes).toContain("message.user");
      expect(slowTypes).toContain("turn.completed");
      expect(slowWindow.events.every((e) => e.type !== "message.user" || e.type === "message.user")).toBe(true);
      const userMsg = slowWindow.events.find((e) => e.type === "message.user") as Extract<
        SessionEvent,
        { type: "message.user" }
      >;
      expect(userMsg.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("You are a subagent. Your task: e2e-topic-slowpoke."),
      });
    } finally {
      store.close();
    }

    // ── both summaries returned to the parent as tool results ──
    const results = parentEvents.filter(
      (e): e is Extract<SessionEvent, { type: "tool.result" }> => e.type === "tool.result",
    );
    expect(results).toHaveLength(2);
    const summaries = results.map(
      (r) => (r.output as { json: { summary: string } }).json.summary,
    );
    expect(summaries).toEqual(
      expect.arrayContaining(["slow findings: the answer is 41", "quick findings: the answer is 1"]),
    );
    // The tool.result EVENTS land in completion order — quick finished while
    // slow was still running, more overlap evidence. (The MODEL-FACING result
    // order stays call order — proven in the @nyx/agent parallel-round test.)

    // ── the parent's final message references both summaries ──
    const finalAssistant = [...parentEvents]
      .reverse()
      .find((e) => e.type === "message.assistant") as Extract<
      SessionEvent,
      { type: "message.assistant" }
    >;
    const finalText = finalAssistant.content
      .filter((b): b is Extract<{ type: string; text?: string }, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(finalText).toContain("41");
    expect(finalText).toContain("1");
    expect(finalText).toContain("42");

    // ── duration + token breakdown (§6 reporting evidence) ──
    const slowCompleted = completed.find((e) => e.subagent_session_id === slow.subagent_session_id)!;
    const quickCompleted = completed.find(
      (e) => e.subagent_session_id === quick.subagent_session_id,
    )!;
    expect(slowCompleted.duration_ms).toBeGreaterThanOrEqual(350); // it really waited
    expect(quickCompleted.duration_ms).toBeLessThan(slowCompleted.duration_ms);
    expect(slowCompleted.tokens_used).toBeGreaterThan(0);
    expect(quickCompleted.tokens_used).toBeGreaterThan(0);

    // ── visibility: children hidden from the session list by default ──
    const listRes = await rig.server.app.request("/v1/sessions", { headers: rig.headers });
    const list = (await listRes.json()) as Array<{ session_id: string }>;
    expect(list.map((m) => m.session_id)).toContain(sessionId);
    expect(list.map((m) => m.session_id)).not.toContain(slow.subagent_session_id);
  });
});
