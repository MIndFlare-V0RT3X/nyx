// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 2 §2.2 acceptance: each tier's trigger and apply, the tier ordering,
// the emergency safety valve, the post-compaction re-read, and golden-file
// snapshots of every tier's plan() and apply(). The LLM tiers run against a
// deterministic fake model; the sandbox is a fake with canned files.

import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  CompletionRequest,
  ExecResult,
  MemoryEntry,
  MemoryStore,
  Message,
  ModelChunk,
  Sandbox,
  SessionEvent,
} from "@nyx/protocol";
import {
  createCompactionPipeline,
  DEFAULT_COMPACTION_CONFIG,
  emergencyTruncate,
  recentlyReferencedPaths,
} from "./compaction-pipeline.js";
import type {
  CompactionConfig,
  CompactionContext,
  CompactionModel,
} from "./compaction-pipeline.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class RecordingModel implements CompactionModel {
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly replies: string[]) {}

  complete(req: CompletionRequest): AsyncIterable<ModelChunk> {
    this.requests.push(req);
    const reply = this.replies.shift() ?? "SUMMARY";
    async function* stream(): AsyncGenerator<ModelChunk> {
      yield { type: "text.delta", text: reply };
      yield { type: "done", finish_reason: "stop" };
    }
    return stream();
  }
}

class FakeMemory implements MemoryStore {
  readonly entries: MemoryEntry[] = [];
  private seq = 0;

  async write(entry: Omit<MemoryEntry, "id" | "created_at" | "updated_at">): Promise<MemoryEntry> {
    const full: MemoryEntry = {
      ...entry,
      id: `mem-${++this.seq}`,
      created_at: 1,
      updated_at: 1,
    };
    this.entries.push(full);
    return full;
  }

  async search() {
    return [];
  }

  async get(id: string) {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  async list(opts?: {
    scope?: MemoryEntry["scope"][];
    kind?: MemoryEntry["kind"];
    limit?: number;
  }) {
    let out = this.entries;
    if (opts?.scope !== undefined) out = out.filter((e) => opts.scope!.includes(e.scope));
    if (opts?.kind !== undefined) out = out.filter((e) => e.kind === opts.kind);
    return opts?.limit !== undefined ? out.slice(0, opts.limit) : out;
  }

  async compact() {
    return { merged: 0, dropped: 0 };
  }
}

class FakeSandbox implements Sandbox {
  readonly id = "fake";
  readonly workdir = "/fake";
  constructor(private readonly files: Record<string, string>) {}
  async exec(): Promise<ExecResult> {
    throw new Error("not implemented");
  }
  async readFile(p: string): Promise<Buffer> {
    const content = this.files[p];
    if (content === undefined) throw new Error(`ENOENT: ${p}`);
    return Buffer.from(content, "utf8");
  }
  async writeFile() {
    throw new Error("not implemented");
  }
  async list() {
    return [];
  }
  async destroy() {
    return;
  }
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

const PREAMBLE: Message[] = [
  { role: "system", content: [{ type: "text", text: "BASE PREAMBLE — contract" }] },
  { role: "system", content: [{ type: "text", text: "SOUL — persona" }] },
];

function turn(i: number, opts: { toolResultChars?: number } = {}): Message[] {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: `user message ${i}` }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", call_id: `c${i}`, name: "fs.read", input: { path: `file-${i}.txt` } },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_result",
          call_id: `c${i}`,
          output: {
            kind: "text",
            text: "x".repeat(opts.toolResultChars ?? 100),
          },
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: `assistant answer ${i}` }] },
  ];
  return messages;
}

function plainTurn(i: number): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: `user message ${i}` }] },
    { role: "assistant", content: [{ type: "text", text: `assistant answer ${i}` }] },
  ];
}

function makeContext(overrides: Partial<CompactionContext> = {}): CompactionContext {
  return {
    session_id: "sess-p",
    turn_id: "turn-p",
    messages: [],
    current_tokens: 0,
    budget_tokens: 100_000,
    reasoning_effort: "low",
    model: new RecordingModel([]),
    memory: new FakeMemory(),
    emit: () => undefined,
    ...overrides,
  };
}

function estimateOf(messages: Message[]): number {
  return Math.ceil(messages.reduce((n, m) => n + JSON.stringify(m).length, 0) / 4);
}

// ---------------------------------------------------------------------------
// Golden files: WRITE_GOLDEN=1 regenerates; otherwise compare.
// ---------------------------------------------------------------------------

const GOLDEN_DIR = join(import.meta.dirname, "golden");
function golden(name: string, actual: string): void {
  const path = join(GOLDEN_DIR, name);
  if (process.env.WRITE_GOLDEN === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, actual, "utf8");
    return;
  }
  if (!existsSync(path)) throw new Error(`golden file missing: ${name} (run with WRITE_GOLDEN=1)`);
  expect(actual).toBe(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("tier 1 — elision (§3.2)", () => {
  it("three large tool outputs trigger elision; oldest dropped, recent kept, under threshold", async () => {
    const events: SessionEvent[] = [];
    // Three turns each with a large tool result; the LAST turn is the current one.
    const messages: Message[] = [
      ...PREAMBLE,
      ...turn(1, { toolResultChars: 12_000 }),
      ...turn(2, { toolResultChars: 12_000 }),
      ...turn(3, { toolResultChars: 12_000 }),
      { role: "user", content: [{ type: "text", text: "current ask" }] },
    ];
    const budget = 6_000; // estimate (~9k+ tokens) exceeds it
    const ctx = makeContext({
      messages,
      current_tokens: estimateOf(messages),
      budget_tokens: budget,
      emit: (e) => events.push(e),
    });
    const result = await createCompactionPipeline().compact(ctx);

    expect(result.tier).toBe("elision");
    expect(events.map((e) => e.type)).toEqual(["compaction.started", "compaction.completed"]);
    expect((events[0] as { strategy: string }).strategy).toBe("rule-elision");

    // Oldest tool outputs are markers now; the current turn's is intact.
    const serialized = JSON.stringify(result.messages);
    expect(serialized).toContain("[elided tool output c1]");
    expect(serialized).toContain("[elided tool output c2]");
    expect(serialized).not.toContain("[elided tool output c3]");
    // Under the elision target (80% of budget).
    expect(estimateOf(result.messages)).toBeLessThanOrEqual(Math.floor(budget * 0.8) + 40);
    // System sections are structurally immune.
    expect(result.messages.slice(0, 2)).toEqual(PREAMBLE);
    // The current user message survives.
    expect(JSON.stringify(result.messages[result.messages.length - 1])).toContain("current ask");
  });

  it("plan golden file", async () => {
    const messages: Message[] = [
      ...PREAMBLE,
      ...turn(1, { toolResultChars: 8_000 }),
      { role: "user", content: [{ type: "text", text: "now" }] },
    ];
    const ctx = makeContext({
      messages,
      current_tokens: estimateOf(messages),
      budget_tokens: 1_000,
    });
    const pipeline = createCompactionPipeline();
    // Snapshot the observable result shape (deterministic).
    const result = await pipeline.compact(ctx);
    golden(
      "tier1-apply.json",
      JSON.stringify(
        {
          tier: result.tier,
          message_roles: result.messages.map((m) => m.role),
          block_kinds: result.messages.map((m) => m.content.map((b) => b.type)),
          markers: JSON.stringify(result.messages).match(/\[elided tool output c\d\]/g) ?? [],
        },
        null,
        2,
      ),
    );
  });
});

describe("tier 2 — session memory (§3.3)", () => {
  it("a 25-turn session at 65% triggers session-memory compaction, writes the memory entry, compresses", async () => {
    const memory = new FakeMemory();
    const model = new RecordingModel([
      "FACTS: did stuff. DECISIONS: ship it. STATE: mid-task. QUESTIONS: none.",
    ]);
    const events: SessionEvent[] = [];
    const messages: Message[] = [
      ...PREAMBLE,
      ...Array.from({ length: 25 }, (_, i) => plainTurn(i + 1)).flat(),
      { role: "user", content: [{ type: "text", text: "current ask" }] },
    ];
    const budget = Math.ceil(estimateOf(messages) / 0.65); // ~65% of window
    const ctx = makeContext({
      messages,
      current_tokens: estimateOf(messages),
      budget_tokens: budget,
      memory,
      model,
      emit: (e) => events.push(e),
    });
    const result = await createCompactionPipeline().compact(ctx);

    expect(result.tier).toBe("session_memory");
    expect((events[0] as { strategy: string }).strategy).toBe("session-memory");
    // The memory entry: scope session, tagged, sourced to this session.
    expect(memory.entries).toHaveLength(1);
    expect(memory.entries[0]).toMatchObject({
      scope: "session",
      kind: "episode",
      source: { session_id: "sess-p", turn_id: "turn-p" },
      tags: ["compaction", "session-memory"],
    });
    // One synthetic system message replaces everything before the last 5
    // turns; the preamble stays; the current ask survives.
    const roles = result.messages.map((m) => m.role);
    expect(roles[0]).toBe("system"); // preamble
    expect(roles[1]).toBe("system"); // preamble
    const memoryMessage = result.messages.find((m) =>
      m.content.some((b) => b.type === "text" && b.text.includes("[session memory")),
    );
    expect(memoryMessage).toBeDefined();
    expect(JSON.stringify(memoryMessage)).toContain("DECISIONS: ship it.");
    // The last 5 turns + current ask remain as real messages.
    const kept = result.messages.slice(result.messages.indexOf(memoryMessage!) + 1);
    expect(kept.filter((m) => m.role === "user")).toHaveLength(5 + 1);
    expect(JSON.stringify(kept[kept.length - 1])).toContain("current ask");
    // Compressed under 60% of the window.
    expect(estimateOf(result.messages)).toBeLessThan(budget * 0.6);
    // The model call was cheap: low effort, no tools.
    expect(model.requests[0]!.reasoning_effort).toBe("low");
    expect(model.requests[0]!.tools).toBeUndefined();
    // "Survives restart": a fresh pipeline reading the same memory store sees it.
    const model2 = new RecordingModel(["second summary"]);
    const ctx2 = makeContext({
      messages,
      current_tokens: estimateOf(messages),
      budget_tokens: budget,
      memory,
      model: model2,
      emit: () => undefined,
    });
    const again = await createCompactionPipeline().compact(ctx2);
    expect(again.tier).toBe("session_memory"); // refresh path
    expect(memory.entries.length).toBe(2);
  });

  it("under the turn minimum it does not fire", async () => {
    const messages: Message[] = [
      ...PREAMBLE,
      ...Array.from({ length: 10 }, (_, i) => plainTurn(i + 1)).flat(),
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];
    const ctx = makeContext({
      messages,
      current_tokens: estimateOf(messages),
      budget_tokens: Math.ceil(estimateOf(messages) / 0.7), // over 60% but too few turns
    });
    const result = await createCompactionPipeline().compact(ctx);
    expect(result.tier).toBeUndefined(); // nothing applicable
  });
});

describe("tier 3 — llm summary (§3.4)", () => {
  it("after tier 2 exists in the session, the next trigger summarizes with the expected shape", async () => {
    const memory = new FakeMemory();
    await memory.write({
      scope: "session",
      kind: "episode",
      content: "old summary",
      source: { session_id: "sess-p" },
      tags: ["compaction", "session-memory"],
    });
    const model = new RecordingModel([
      "Decisions:\n- use sqlite\nCurrent task state:\n- migrating db\nOpen questions:\n- none",
    ]);
    const events: SessionEvent[] = [];
    const messages: Message[] = [
      ...PREAMBLE,
      ...Array.from({ length: 8 }, (_, i) => plainTurn(i + 1)).flat(),
      { role: "user", content: [{ type: "text", text: "current ask" }] },
    ];
    // Session memory exists → tier 3 precondition met even though we are
    // under the 80% fraction.
    const budget = estimateOf(messages) * 2;
    const ctx = makeContext({
      messages,
      current_tokens: estimateOf(messages),
      budget_tokens: budget,
      memory,
      model,
      emit: (e) => events.push(e),
    });
    const result = await createCompactionPipeline().compact(ctx);

    expect(result.tier).toBe("llm_summary");
    expect((events[0] as { strategy: string }).strategy).toBe("llm-summary");
    const summaryMessage = result.messages.find((m) =>
      m.content.some((b) => b.type === "text" && b.text.includes("[conversation summary")),
    );
    expect(summaryMessage).toBeDefined();
    const text = JSON.stringify(summaryMessage);
    expect(text).toContain("Decisions:");
    expect(text).toContain("Current task state:");
    expect(text).toContain("Open questions:");
    // The current ask is never summarized away.
    expect(JSON.stringify(result.messages[result.messages.length - 1])).toContain("current ask");
    // Golden: the summary message shape.
    golden(
      "tier3-apply.json",
      JSON.stringify(
        {
          tier: result.tier,
          message_roles: result.messages.map((m) => m.role),
          summary_block_kind: summaryMessage!.content[0]!.type,
        },
        null,
        2,
      ),
    );
  });
});

describe("tier 4 — emergency degrade (§3.5)", () => {
  it("a session forced to 96% (tiers 1-3 not applicable) drops the oldest half, retains the last 10, warns", async () => {
    const warnings: Array<[string, Record<string, unknown>]> = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg: string, c: Record<string, unknown>) => warnings.push([msg, c]),
      error: () => undefined,
      child: () => logger,
    };
    const events: SessionEvent[] = [];
    // No tool results (tier 1 null), 6 turns (tier 2 null), and a config that
    // keeps tier 3 out of the way so emergency is isolated.
    const filler: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: `filler ${i} `.repeat(200) }],
    }));
    const messages: Message[] = [
      ...PREAMBLE,
      ...Array.from({ length: 6 }, (_, i) => plainTurn(i + 1)).flat(),
      ...filler,
      { role: "user", content: [{ type: "text", text: "current ask" }] },
    ];
    const budget = Math.ceil(estimateOf(messages) / 0.96);
    const config: Partial<CompactionConfig> = { llm_summary_threshold: 0.99 };
    const ctx = makeContext({
      messages,
      current_tokens: estimateOf(messages),
      budget_tokens: budget,
      emit: (e) => events.push(e),
      logger,
    });
    const result = await createCompactionPipeline(config).compact(ctx);

    expect(result.tier).toBe("emergency");
    const strategies = events
      .filter((e) => e.type === "compaction.started")
      .map((e) => (e as { strategy: string }).strategy);
    expect(strategies).toEqual(["emergency-degrade"]);
    // Dropped roughly half; at least 10 retained; the current ask survives.
    expect(result.messages.length).toBeLessThan(messages.length - 5);
    expect(result.messages.length).toBeGreaterThanOrEqual(10);
    expect(JSON.stringify(result.messages[result.messages.length - 1])).toContain("current ask");
    // The operator warning fired.
    expect(warnings.map(([m]) => m)).toContain("compaction.emergency");
    // Golden: the plan shape.
    golden(
      "tier4-apply.json",
      JSON.stringify(
        {
          tier: result.tier,
          kept_messages: result.messages.length,
          original_messages: messages.length,
          last_message_role: result.messages[result.messages.length - 1]!.role,
        },
        null,
        2,
      ),
    );
  });

  it("emergencyTruncate: last 10 always retained, preamble survives when it fits", () => {
    const messages: Message[] = [
      ...PREAMBLE,
      ...Array.from({ length: 38 }, (_, i) => plainTurn(i + 1)).flat(),
    ];
    const truncated = emergencyTruncate(messages);
    expect(truncated.length).toBeGreaterThanOrEqual(10);
    expect(truncated.length).toBeLessThan(messages.length);
    // The preamble (2 system messages) survives ahead of the retained tail.
    expect(truncated[0]!.role).toBe("system");
    expect(truncated[1]!.role).toBe("system");
    // The retained tail is the list's own suffix.
    const tail = messages.slice(messages.length - (truncated.length - 2));
    expect(truncated.slice(2)).toEqual(tail);
  });
});

describe("post-compaction re-read (§3.6)", () => {
  it("a file referenced mid-edit is re-read after compaction, capped", async () => {
    const sandbox = new FakeSandbox({
      "big-output.txt": "z".repeat(30_000),
      "editing.txt": "THE FILE BEING EDITED — line 1\nline 2\n",
      "other.txt": "o".repeat(30_000),
    });
    const events: SessionEvent[] = [];
    // History: an old fs.read of big-output.txt (huge result → elision), and
    // a recent fs.write of editing.txt (mid-edit).
    const messages: Message[] = [
      ...PREAMBLE,
      { role: "user", content: [{ type: "text", text: "read big" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", call_id: "c1", name: "fs.read", input: { path: "big-output.txt" } },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_result",
            call_id: "c1",
            output: { kind: "text", text: "z".repeat(30_000) },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "got it" }] },
      { role: "user", content: [{ type: "text", text: "now edit editing.txt" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            call_id: "c2",
            name: "fs.write",
            input: { path: "editing.txt", content: "draft" },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "continue the edit" }] },
    ];
    const budget = 4_000;
    const ctx = makeContext({
      messages,
      current_tokens: estimateOf(messages),
      budget_tokens: budget,
      sandbox,
      emit: (e) => events.push(e),
    });
    const result = await createCompactionPipeline().compact(ctx);

    expect(result.tier).toBe("elision");
    // editing.txt is back in context after the compaction dropped content.
    const reread = result.messages.find((m) =>
      m.content.some(
        (b) => b.type === "text" && b.text.includes("[context re-read after compaction"),
      ),
    );
    expect(reread).toBeDefined();
    const text = JSON.stringify(reread);
    expect(text).toContain("editing.txt");
    expect(text).toContain("THE FILE BEING EDITED");
    // The huge file is NOT re-read (cap): only files within the budget.
    expect(text).not.toContain("big-output.txt");
  });

  it("recentlyReferencedPaths: newest first, distinct, tool-scoped", () => {
    const messages: Message[] = [
      ...PREAMBLE,
      { role: "user", content: [{ type: "text", text: "u1" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", call_id: "a", name: "fs.read", input: { path: "a.txt" } }],
      },
      { role: "user", content: [{ type: "text", text: "u2" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            call_id: "b",
            name: "fs.write",
            input: { path: "b.txt", content: "x" },
          },
          { type: "tool_use", call_id: "c", name: "web.fetch", input: { url: "http://x" } },
        ],
      },
      { role: "user", content: [{ type: "text", text: "u3" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", call_id: "d", name: "fs.read", input: { path: "a.txt" } }],
      },
    ];
    expect(recentlyReferencedPaths(messages)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("pipeline behavior", () => {
  it("first non-null plan wins: elision preempts session memory when both apply", async () => {
    const model = new RecordingModel(["should not be called"]);
    const memory = new FakeMemory();
    const messages: Message[] = [
      ...PREAMBLE,
      ...Array.from({ length: 25 }, (_, i) => turn(i + 1, { toolResultChars: 3_000 })).flat(),
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];
    const budget = Math.ceil(estimateOf(messages) / 0.7);
    const result = await createCompactionPipeline().compact(
      makeContext({
        messages,
        current_tokens: estimateOf(messages),
        budget_tokens: budget,
        model,
        memory,
      }),
    );
    expect(result.tier).toBe("elision");
    expect(model.requests).toHaveLength(0); // no LLM call
    expect(memory.entries).toHaveLength(0);
  });

  it("a small session no-ops: no tiers, no events, identical messages", async () => {
    const events: SessionEvent[] = [];
    const messages: Message[] = [...PREAMBLE, ...plainTurn(1)];
    const result = await createCompactionPipeline().compact(
      makeContext({
        messages,
        current_tokens: estimateOf(messages),
        budget_tokens: 100_000,
        emit: (e) => events.push(e),
      }),
    );
    expect(result.tier).toBeUndefined();
    expect(result.freed_tokens).toBe(0);
    expect(result.messages).toEqual(messages);
    expect(events).toEqual([]);
  });

  it("enabled: false disables compaction entirely", async () => {
    const messages: Message[] = [
      ...PREAMBLE,
      ...turn(1, { toolResultChars: 30_000 }),
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];
    const result = await createCompactionPipeline({ enabled: false }).compact(
      makeContext({ messages, current_tokens: estimateOf(messages), budget_tokens: 1_000 }),
    );
    expect(result.messages).toEqual(messages);
    expect(result.tier).toBeUndefined();
  });

  it("defaults match the config contract (§3.7)", () => {
    expect(DEFAULT_COMPACTION_CONFIG).toEqual({
      elision_threshold_tokens: 5_000,
      session_memory_threshold: 0.6,
      session_memory_min_turns: 20,
      llm_summary_threshold: 0.8,
      emergency_threshold: 0.95,
      post_compaction_reread_tokens: 5_000,
      post_compaction_reread_files: 5,
      enabled: true,
      verbose_events: false,
    });
  });
});
