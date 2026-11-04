// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 3 §5.1 — FAN-OUT VALIDATION, re-runnable.
//
// The subagent system reviews itself: a parent turn spawns THREE reviewer
// subagents in one round (parallel dispatch), each restricted to fs.read +
// grep (reviewers report, they don't fix), each reading the REAL Phase 3
// sources copied into its sandbox before returning its findings.
//
// Provenance note (documented in SUBAGENTS.md): NYX is a harness, not a
// model — it has no bundled LLM. The scripted provider stands in for the
// reviewer models: round 1 performs REAL tool calls against the real files
// (the outputs land in each child's event log), round 2 returns findings
// authored by Fizz after reviewing the same code. The machinery under test
// — spawn, parallelism, isolation, allowlists, budgets, mirrored events —
// is entirely real.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { ApprovalEngineImpl, PolicyEngineImpl } from "@nyx/policy";
import { MemoryStoreImpl } from "@nyx/memory";
import { ModelRouterImpl, ProviderRegistryImpl } from "@nyx/model";
import type { MockTurn } from "@nyx/model";
import { openSessionStore } from "@nyx/session";
import { createKernel } from "@nyx/kernel";
import {
  createToolRuntime,
  registerBuiltinTools,
  ToolRegistryImpl,
  ToolRouterImpl,
} from "@nyx/tools";
import type {
  CompletionRequest,
  ModelChunk,
  ModelInfo,
  ModelProvider,
  RunContext,
  SessionStore,
  ToolHandler,
} from "@nyx/protocol";
import {
  createSubagentManager,
  registerSubagentTool,
  resolveSubagentsConfig,
  type SubagentManager,
} from "@nyx/subagents";

/** The sources under review (relative to the repo root). */
const REVIEW_FILES = [
  "packages/subagents/src/manager.ts",
  "packages/subagents/src/child-views.ts",
  "packages/subagents/src/config.ts",
  "packages/subagents/src/tool.ts",
  "packages/subagents/src/memory-view.ts",
  "packages/subagents/src/control.ts",
  "packages/subagents/src/manager.test.ts",
  "packages/tools/src/runtime.ts",
  "packages/tools/src/router.ts",
  "packages/tools/src/registry.ts",
];

/** grep over the sandbox workdir: regex per line, capped matches. */
function makeGrepHandler(): ToolHandler {
  return {
    async execute(call, ctx) {
      const input = call.input as { pattern: string; path?: string };
      const re = new RegExp(input.pattern, "i");
      const root = join(ctx.sandbox.workdir, input.path ?? ".");
      const matches: Array<{ file: string; line: number; text: string }> = [];
      let truncated = false;

      const walk = async (dir: string, rel: string): Promise<void> => {
        if (truncated) return;
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (truncated) return;
          const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) {
            await walk(join(dir, entry.name), relPath);
          } else if (entry.name.endsWith(".ts")) {
            const text = await readFile(join(dir, entry.name), "utf8");
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i]!)) {
                matches.push({ file: relPath, line: i + 1, text: lines[i]!.trim().slice(0, 160) });
                if (matches.length >= 200) {
                  truncated = true;
                  return;
                }
              }
            }
          }
        }
      };
      await walk(root, input.path ?? ".");
      return { kind: "json", json: { matches, truncated } };
    },
  };
}

/** Marker-dispatch provider (children keyed on task markers, parent = fallback). */
class ReviewerProvider implements ModelProvider {
  readonly id = "mock";
  private readonly byMarker = new Map<string, MockTurn[]>();
  private readonly fallback: MockTurn[] = [];
  private readonly models: ModelInfo[] = [
    { id: "mock-1", context_window: 128000, max_output: 8192, supports: ["tools"] },
  ];

  script(marker: string, turns: MockTurn[]): this {
    this.byMarker.set(marker, [...turns]);
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
    const marker = [...this.byMarker.keys()].find((m) => text.includes(m));
    const queue = marker !== undefined ? this.byMarker.get(marker)! : this.fallback;
    const turn = queue.shift();
    if (turn === undefined) throw new Error("reviewer provider: script exhausted");
    if (!Array.isArray(turn)) throw new Error(turn.fail.message);
    for (const chunk of turn) yield chunk;
  }
}

function toolCalls(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): ModelChunk[] {
  return [
    ...calls.flatMap((c, i) => [
      {
        type: "tool_call.delta",
        index: i,
        id: c.id,
        name: c.name,
        arguments_delta: JSON.stringify(c.input),
      },
    ]),
    { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    { type: "done", finish_reason: "tool_calls" },
  ];
}

function findingsTurn(text: string): ModelChunk[] {
  return [
    { type: "text.delta", text },
    { type: "usage", usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
    { type: "done", finish_reason: "stop" },
  ];
}

// ── The three reviewers' findings (Fizz-authored after reviewing the same
// files the subagents read; severities + file references included). ──

const REVIEWER_1_FINDINGS = `Findings — depth, budget, and tool-allowlist enforcement:
1. [MEDIUM][FIXED] manager.ts:207-332 — a throw between running.set and the child-loop try (e.g. a failed mirrored-event append) leaked the running entry; list() would report that child "running" forever. Fixed: the guard try/finally now spans running.set to settle.
2. [MEDIUM][FIXED] manager.ts:157-172 — the per-turn budget check-then-set is synchronous between awaits, so two same-turn spawns racing on max_total_per_turn cannot both reserve; added a regression test (exactly one of two 60k spawns against a 100k cap wins).
3. [LOW][ACCEPTED] manager.ts:162-196 — the budget allocation rolls back only on session-create failure; a later throw leaves the allocation counted. Conservative (over-counting denies, never overspends); accepted and documented.
4. [VERIFIED] manager.ts depthOf walks the parent_id chain counting kind="subagent" ancestors with a seen-set cycle guard; a recursive spawn that passes a subagent session id as the parent is rejected with depth_exceeded (tested), and max_depth_override clamps via Math.min so it can only tighten (tested).
5. [VERIFIED] child-views.ts childToolAllowlist gates three ways — structural spawn_subagent rejection independent of config, config forbidden_tools, and spec allowlist intersected with the parent registry; an allowlist naming tools the parent lacks grants nothing (tested).`;

const REVIEWER_2_FINDINGS = `Findings — abort propagation and session isolation:
1. [HIGH][FIXED] manager.ts abort-reason tracking — subagent.aborted previously hardcoded "abort requested" for both in-process and cross-process aborts; now each path records its own reason (parent turn aborted / abort requested / abort requested (external)), tested on all three paths.
2. [MEDIUM][DOCUMENTED] abort teardown depends on the provider honoring CompletionRequest.signal: the runtime's abortRace rejects in-flight tools, and real providers (openai-compatible.ts, anthropic.ts) pass the signal to their SDK clients, but a provider that ignores it hangs the child until the spawn tool's 10-minute wall clock. Recorded as a provider contract in SUBAGENTS.md.
3. [VERIFIED] manager.ts:285-313 — the cross-process abort poll races the child event iterator without losing a pending next() (the same pending promise is re-raced after every poll win); verified with a second db handle standing in for another process.
4. [VERIFIED] child events never enter the parent's log: the child loop appends to the child session id, and the manager mirrors only subagent.* lifecycle events — asserted by exact event-sequence equality in the unit and e2e suites.
5. [VERIFIED] memory-view.ts — writes to scope "session" are mapped onto scope "subagent" with source.session_id = the child id; reads see only the child's own subagent entries plus global (persona/owner silently excluded, deny-first); get() ownership-filters so an id-guessing read of parent memory returns null; compact() is a no-op. All tested.`;

const REVIEWER_3_FINDINGS = `Findings — tool router filtering:
1. [HIGH][VERIFIED] spawn_subagent is structurally absent from subagent registries: the child registry is a FilteredToolRegistry whose predicate hardcodes name !== "spawn_subagent" (config cannot re-enable it, hard rule #7), and — the load-bearing part — the child's TOOL RUNTIME (ChildKernelView, service "tools.runtime") is built over the filtered registry, so enforcement sits on the execution path, not just the model-facing catalog. The loop builds both the request tools list and the prompt's tools_catalog from ctx.tools.list(); an attempted call yields tool.error code tool_unknown with a clean model-facing "unknown tool" (tested at unit level in the manager suite; the server suite proves the route wiring).
2. [MEDIUM][VERIFIED] tool.ts registerSubagentTool early-returns when max_depth is 0 — "no spawning at all" is the tool's absence, not a runtime check the model could probe (tested).
3. [LOW][NOTED] FilteredToolRegistry.register/unregister delegate to the parent registry; a plugin registering a tool during a child run mutates the parent registry but not the child's already-fixed allowlist — safe direction, noted.
4. [VERIFIED] ChildKernelView overrides exactly one service ("tools.runtime") and shares hooks and the compaction pipeline; a hook therefore observes child actions with the child's session id, which the test suite uses to capture and inspect the child's RunContext wiring.`;

describe("fan-out validation (Phase 3 §5.1): three parallel reviewers", () => {
  let store: SessionStore;
  let dataDir: string;
  let sandboxRoot: string;
  let memoryRoot: string;
  let manager: SubagentManager;
  let provider: ReviewerProvider;
  let parentCtx: RunContext;
  let sessionId: string;
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "nyx-fanout-data-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "nyx-fanout-sbx-"));
    memoryRoot = await mkdtemp(join(tmpdir(), "nyx-fanout-mem-"));
    const repoRoot = resolve(process.cwd(), "../..");

    // The reviewers' sandbox: a copy of the real sources under review.
    const { mkdir } = await import("node:fs/promises");
    for (const file of REVIEW_FILES) {
      const target = join(sandboxRoot, file);
      await mkdir(join(target, ".."), { recursive: true });
      await cp(join(repoRoot, file), target);
    }

    store = openSessionStore(join(dataDir, "nyx.db"));
    const session = await store.create({ owner_id: "owner", persona_id: "default" });
    sessionId = session.session_id;

    provider = new ReviewerProvider();
    const registry = new ProviderRegistryImpl();
    registry.register(provider);
    const model = new ModelRouterImpl(registry, {
      default: { chain: [{ provider: "mock", model: "mock-1" }] },
    });

    const db = new Database(":memory:");
    cleanup.push(() => Promise.resolve(db.close()));
    const approvals = new ApprovalEngineImpl(db, { poll_ms: 5 });
    const policy = new PolicyEngineImpl([
      { id: "allow-r0", match: { risk: "R0" }, decision: "allow" },
      { id: "allow-r1", match: { risk: "R1" }, decision: "allow" },
    ]);
    const toolRegistry = new ToolRegistryImpl();
    registerBuiltinTools(toolRegistry);
    // The reviewers' second tool: grep (read-only search).
    toolRegistry.register(
      {
        name: "grep",
        description:
          "Search .ts files under a sandbox path for a regex; returns file:line matches.",
        input_schema: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
          },
          required: ["pattern"],
        },
        risk: "R0",
        capabilities: ["fs.read"],
        handler: "builtin:grep",
      },
      makeGrepHandler(),
    );
    const runtime = createToolRuntime({
      registry: toolRegistry,
      router: new ToolRouterImpl(),
      policy,
      approvals,
    });
    const kernel = createKernel();
    kernel.services.set("tools.runtime", runtime);

    const memory = new MemoryStoreImpl(memoryRoot);
    cleanup.push(() => Promise.resolve(memory.close()));

    // sandbox_sharing pinned to "inherit": this rig's parent sandbox is a
    // hand-rolled read-only view over the REAL repo files (not a forkable
    // provider sandbox) — Phase 4's fork default would refuse it loudly.
    const config = resolveSubagentsConfig({
      default_budget_tokens: 8_192,
      sandbox_sharing: "inherit",
    });
    manager = createSubagentManager({
      store,
      config: { default_budget_tokens: 8_192, sandbox_sharing: "inherit" },
    });
    registerSubagentTool(toolRegistry, { manager, config });

    const quiet = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    };
    parentCtx = {
      kernel,
      session: store,
      model,
      tools: toolRegistry,
      tool_router: new ToolRouterImpl(),
      policy,
      approvals,
      sandbox: {
        id: "fanout",
        workdir: sandboxRoot,
        exec: async () => ({
          exit_code: 0,
          stdout: "",
          stderr: "",
          duration_ms: 0,
          truncated: false,
        }),
        readFile: async (p: string) => readFile(p),
        writeFile: async () => undefined,
        list: async () => [],
        destroy: async () => undefined,
      },
      memory,
      persona: { persona_id: "default", buildSystemPrompt: () => [] },
      signal: new AbortController().signal,
      logger: quiet as never,
    };

    // ── The three reviewers' scripts: REAL reads/greps first, findings after.
    const readCall = (id: string, path: string) => ({
      id,
      name: "fs.read",
      input: { path },
    });
    provider.script("R1-depth-budget-allowlist", [
      toolCalls([
        readCall("r1a", "packages/subagents/src/manager.ts"),
        readCall("r1b", "packages/subagents/src/child-views.ts"),
        { id: "r1c", name: "grep", input: { pattern: "turnSpend|max_depth|forbidden_tools" } },
      ]),
      findingsTurn(REVIEWER_1_FINDINGS),
    ]);
    provider.script("R2-abort-isolation-memory", [
      toolCalls([
        readCall("r2a", "packages/subagents/src/manager.ts"),
        readCall("r2b", "packages/subagents/src/memory-view.ts"),
        { id: "r2c", name: "grep", input: { pattern: "subagent.aborted|registerPresenter|scope" } },
      ]),
      findingsTurn(REVIEWER_2_FINDINGS),
    ]);
    provider.script("R3-tool-router-filtering", [
      toolCalls([
        readCall("r3a", "packages/subagents/src/child-views.ts"),
        readCall("r3b", "packages/tools/src/runtime.ts"),
        {
          id: "r3c",
          name: "grep",
          input: { pattern: "tools.runtime|tool_unknown|spawn_subagent" },
        },
      ]),
      findingsTurn(REVIEWER_3_FINDINGS),
    ]);
    // The parent fans out all three in ONE round.
    provider.scriptParent([
      toolCalls([
        {
          id: "s1",
          name: "spawn_subagent",
          input: {
            task: "R1-depth-budget-allowlist: verify depth, budget, and tool-allowlist enforcement",
            tools: ["fs.read", "grep"],
          },
        },
        {
          id: "s2",
          name: "spawn_subagent",
          input: {
            task: "R2-abort-isolation-memory: verify abort propagation and session isolation",
            tools: ["fs.read", "grep"],
          },
        },
        {
          id: "s3",
          name: "spawn_subagent",
          input: {
            task: "R3-tool-router-filtering: verify spawn_subagent is structurally filtered",
            tools: ["fs.read", "grep"],
          },
        },
      ]),
      findingsTurn("All three reviewers returned; integrating findings."),
    ]);
  });

  afterAll(async () => {
    for (const fn of cleanup) await fn();
    store?.close();
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(sandboxRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(memoryRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it("spawns 3 reviewers in parallel over the real sources; all return findings", async () => {
    const startedAt = Date.now();
    manager.bindTurn(sessionId, "fanout-t1", parentCtx);
    const { createAgentLoop } = await import("@nyx/agent");
    const loop = createAgentLoop();
    for await (const _event of loop.run(
      {
        session_id: sessionId,
        turn_id: "fanout-t1",
        user_message: {
          role: "user",
          content: [
            { type: "text", text: "Review the subagent system with three parallel reviewers." },
          ],
        },
      },
      parentCtx,
    )) {
      void _event; // consuming keeps the generator alive
    }
    manager.unbindTurn(sessionId);
    // The mirrored subagent.* events are appended directly to the store by
    // the manager (they don't flow through the loop's pump) — read the log.
    const events = await store.read(sessionId);

    // ── all 3 spawned, all 3 returned ──
    const spawned = events.filter((e) => e.type === "subagent.spawned");
    const completed = events.filter((e) => e.type === "subagent.completed");
    expect(spawned).toHaveLength(3);
    expect(completed).toHaveLength(3);
    expect(events.filter((e) => e.type === "subagent.failed")).toHaveLength(0);
    expect(events[events.length - 1]!.type).toBe("turn.completed");

    // ── the three SubagentResults came back as tool results ──
    const results = events.filter((e) => e.type === "tool.result");
    const summaries = results.map(
      (r) => (r as { output: { json: { summary: string; state: string } } }).output.json,
    );
    const reviewerSummaries = summaries.filter((s) => s.summary.startsWith("Findings"));
    expect(reviewerSummaries).toHaveLength(3);
    expect(reviewerSummaries.every((s) => s.state === "completed")).toBe(true);

    // ── each reviewer REALLY read the sources: its log carries the
    //    tool.call/tool.result pairs for fs.read + grep against real files ──
    const childIds = spawned.map((e) => (e as { subagent_session_id: string }).subagent_session_id);
    const childToolNames = new Set<string>();
    let grepMatchesTotal = 0;
    for (const id of childIds) {
      const childEvents = await store.read(id);
      const calls = childEvents.filter((e) => e.type === "tool.call") as Array<{
        name: string;
        input: unknown;
      }>;
      const results2 = childEvents.filter((e) => e.type === "tool.result") as Array<{
        output: { kind: string; json?: { matches?: unknown[] }; text?: string };
      }>;
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const call of calls) childToolNames.add(call.name);
      // No writes, no shell: the allowlist held.
      expect(calls.every((c) => c.name === "fs.read" || c.name === "grep")).toBe(true);
      // The fs.read results carry real file content (manager.ts is >10kB).
      const readResult = results2.find((r) => r.output.kind === "text");
      expect(readResult?.output.text?.length ?? 0).toBeGreaterThan(5_000);
      const grepResult = results2.find((r) => r.output.kind === "json");
      grepMatchesTotal += (grepResult?.output.json?.matches as unknown[] | undefined)?.length ?? 0;
      // The final assistant message carries the findings.
      const last = [...childEvents].reverse().find((e) => e.type === "message.assistant") as {
        content: Array<{ type: string; text?: string }>;
      };
      expect(last.content.some((b) => (b.text ?? "").startsWith("Findings"))).toBe(true);
    }
    expect(childToolNames).toEqual(new Set(["fs.read", "grep"]));
    expect(grepMatchesTotal).toBeGreaterThan(10);

    // ── parallel: all three windows overlap pairwise ──
    const window = async (id: string): Promise<{ start: number; end: number }> => {
      const evs = await store.read(id);
      return {
        start: evs.find((e) => e.type === "turn.started")?.ts ?? 0,
        end: [...evs].reverse().find((e) => e.type === "turn.completed")?.ts ?? 0,
      };
    };
    const windows = [];
    for (const id of childIds) windows.push(await window(id));
    for (let i = 0; i < windows.length; i++) {
      for (let j = i + 1; j < windows.length; j++) {
        expect(windows[i]!.start).toBeLessThanOrEqual(windows[j]!.end);
        expect(windows[j]!.start).toBeLessThanOrEqual(windows[i]!.end);
      }
    }
    const totalWall = Math.max(...windows.map((w) => w.end)) - startedAt;
    const sumDurations = completed.reduce(
      (acc, e) => acc + (e as { duration_ms: number }).duration_ms,
      0,
    );
    expect(sumDurations).toBeGreaterThan(totalWall); // they overlapped

    // ── token breakdown for the report ──
    const tokens = completed.reduce(
      (acc, e) => acc + (e as { tokens_used: number }).tokens_used,
      0,
    );
    expect(tokens).toBeGreaterThan(0);
    console.log(
      `[fanout] 3 reviewers: ${childIds.length} sessions, wall ${totalWall}ms, ` +
        `sum(durations) ${sumDurations}ms, tokens ${tokens}, grep matches ${grepMatchesTotal}`,
    );
    for (const s of reviewerSummaries) {
      console.log(`[fanout] ${s.summary.split("\n")[0]}`);
    }
  });
});
