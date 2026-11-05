// SPDX-License-Identifier: AGPL-3.0-or-later
// `nyx subagents` acceptance (Phase 3 §3.2): a real spawn driven through the
// CLI's local runtime (the same wiring `nyx run`/`nyx chat` use), then the
// read-only list, the cross-process abort delivery, and the session-list
// visibility rules (--all with the ↳ prefix, show's lineage hint).

import { describe, expect, it } from "vitest";
import type { CompletionRequest, ModelChunk, ModelInfo, ModelProvider } from "@nyx/protocol";
import type { MockTurn } from "@nyx/model";
import { makeRig, until } from "./harness.test.js";
import { listSessions, showSession, renderSessionList } from "./sessions.js";
import { abortSubagent, listSubagents, renderSubagentList } from "./subagents.js";

/** Marker-dispatch provider: each child's script keys on its task marker. */
class DispatchProvider implements ModelProvider {
  readonly id = "mock";
  private readonly byMarker = new Map<string, MockTurn[]>();
  private readonly hangingMarkers = new Set<string>();
  private readonly fallback: MockTurn[] = [];
  private readonly models: ModelInfo[] = [
    { id: "mock-1", context_window: 128000, max_output: 8192, supports: ["tools"] },
  ];

  script(marker: string, turns: MockTurn[]): this {
    this.byMarker.set(marker, [...turns]);
    return this;
  }

  /** Markers whose model call streams one delta and then never ends. */
  hang(marker: string): this {
    this.hangingMarkers.add(marker);
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
    for (const marker of this.hangingMarkers) {
      if (text.includes(marker)) {
        yield { type: "text.delta", text: "working" };
        // Hangs until the request's AbortSignal fires — exactly how the real
        // providers behave (they hand the signal to their SDK clients).
        await new Promise<never>((_resolve, reject) => {
          const abort = (): void => reject(new Error("aborted"));
          if (req.signal?.aborted) abort();
          else req.signal?.addEventListener("abort", abort, { once: true });
        });
        return;
      }
    }
    const turn = this.next(req);
    if (turn === undefined) throw new Error("dispatch provider: script exhausted");
    if (!Array.isArray(turn)) throw new Error(turn.fail.message);
    for (const chunk of turn) yield chunk;
  }

  private next(req: CompletionRequest): MockTurn | undefined {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
    for (const marker of this.byMarker.keys()) {
      if (text.includes(marker)) return this.byMarker.get(marker)!.shift();
    }
    return this.fallback.shift();
  }
}

function spawnTurn(task: string, callId = "c1"): ModelChunk[] {
  return [
    {
      type: "tool_call.delta",
      index: 0,
      id: callId,
      name: "spawn_subagent",
      arguments_delta: JSON.stringify({ task }),
    },
    { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    { type: "done", finish_reason: "tool_calls" },
  ];
}

function textTurn(text: string): ModelChunk[] {
  return [
    { type: "text.delta", text },
    { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    { type: "done", finish_reason: "stop" },
  ];
}

/** Drives one parent turn through the CLI runtime; returns the session id. */
async function runSpawnTurn(
  rig: Awaited<ReturnType<typeof makeRig>>,
  provider: DispatchProvider,
): Promise<{
  runtime: ReturnType<Awaited<ReturnType<typeof makeRig>>["runtime"]>;
  session_id: string;
}> {
  const runtime = await rig.runtime([provider]);
  const session = await runtime.createSession({ title: "cli subagent test" });
  const result = await runtime.runTurn({
    session_id: session.session_id,
    turn_id: "t1",
    content: [{ type: "text", text: "delegate the work" }],
  });
  expect(result.completed).toBe(true);
  return { runtime, session_id: session.session_id };
}

describe("nyx subagents (CLI)", () => {
  it("lists children after a real spawn; sessions list hides them unless --all", async () => {
    const rig = await makeRig();
    const provider = new DispatchProvider();
    provider.script("cli-child-task", [textTurn("child did the work")]);
    provider.scriptParent([spawnTurn("cli-child-task"), textTurn("parent synthesized")]);
    const { runtime, session_id } = await runSpawnTurn(rig, provider);

    const infos = await listSubagents(rig.dirs.data, session_id);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({
      parent_session_id: session_id,
      parent_turn_id: "t1",
      state: "completed",
      task: "cli-child-task",
    });
    const childId = infos[0]!.session_id;

    // Rendered table carries state + task.
    const rendered = renderSubagentList(infos);
    expect(rendered).toContain("completed");
    expect(rendered).toContain("cli-child-task");

    // sessions list: hidden by default, ↳-prefixed with --all.
    const hidden = await listSessions(rig.dirs.data, 50, false);
    expect(hidden.map((r) => r.session_id)).not.toContain(childId);
    const all = await listSessions(rig.dirs.data, 50, true);
    const childRow = all.find((r) => r.session_id === childId);
    expect(childRow?.kind).toBe("subagent");
    expect(childRow?.parent_id).toBe(session_id);
    const renderedAll = renderSessionList(all);
    expect(renderedAll).toContain(`↳ ${childId}`);
    expect(renderedAll).toContain(`of ${session_id}`);

    // sessions show: lineage hint for the subagent.
    const detail = await showSession(rig.dirs.data, childId);
    const shown = await import("./sessions.js").then((m) => m.renderSessionDetail(detail));
    expect(shown).toContain(`subagent  of ${session_id} (turn t1)`);

    // list of an unknown parent errors cleanly.
    await expect(listSubagents(rig.dirs.data, "nope")).rejects.toMatchObject({
      code: "not_found",
    });

    await runtime.close();
  });

  it("abortSubagent writes a control row for a running child and no-ops for settled ones", async () => {
    const rig = await makeRig();
    const provider = new DispatchProvider();
    // A never-ending child: its model call streams one delta, then hangs.
    provider.hang("cli-hang-task");
    provider.scriptParent([spawnTurn("cli-hang-task"), textTurn("never reached")]);

    const runtime = await rig.runtime([provider]);
    const session = await runtime.createSession({});
    const turn = runtime.runTurn({
      session_id: session.session_id,
      turn_id: "t1",
      content: [{ type: "text", text: "delegate" }],
    });
    // Wait for the child to exist…
    let childId = "";
    await until(async () => {
      const infos = await listSubagents(rig.dirs.data, session.session_id);
      childId = infos[0]?.session_id ?? "";
      return childId !== "";
    });

    // The "other process" (this test, standing in for `nyx subagents abort`)
    // delivers the abort through nyx.db.
    const result = await abortSubagent(rig.dirs.data, childId, "cli:test");
    expect(result.requested).toBe(true);

    // The parent turn COMPLETES: the aborted child comes back as the spawn
    // tool's result (state "aborted") and the parent's model continues.
    const turnResult = await turn;
    expect(turnResult.completed).toBe(true);
    const spawnResult = turnResult.events.find(
      (e) => e.type === "tool.result" && e.call_id === "c1",
    );
    expect(spawnResult).toMatchObject({
      output: { kind: "json", json: { state: "aborted" } },
    });

    // The child settled as aborted; a second abort is a no-op.
    await until(async () => {
      const infos = await listSubagents(rig.dirs.data, session.session_id);
      return infos[0]?.state === "aborted";
    });
    const settled = await abortSubagent(rig.dirs.data, childId, "cli:test");
    expect(settled.requested).toBe(false);
    expect(settled.note).toContain("not running");

    // Non-subagent sessions are rejected.
    await expect(
      abortSubagent(rig.dirs.data, session.session_id, "cli:test"),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await runtime.close();
  });
});
