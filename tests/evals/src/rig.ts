// SPDX-License-Identifier: AGPL-3.0-or-later
// The eval rig: REAL components everywhere except the model (a scripted
// mock) — the same posture as the e2e harnesses. Real session store
// (:memory: + audit), real policy engine, real tool runtime, real kernel,
// real memory store, real subagent manager, real sandbox (tmpdir). The
// scripted provider + scripted approval outcomes are the two seams a
// behavioral eval needs to drive a specific trajectory.

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import type {
  ApprovalContext,
  ApprovalEngine,
  CompletionRequest,
  ApprovalRecord,
  Engagement,
  ExecResult,
  Logger,
  MemoryEntry,
  Message,
  ModelChunk,
  ModelInfo,
  ModelProvider,
  PersonaRuntime,
  PolicyRule,
  PolicyVerdict,
  PromptAssemblyInput,
  PromptSection,
  RunContext,
  Sandbox,
  SessionEvent,
  SessionMeta,
  SessionStore,
  ToolHandler,
  ToolOutput,
} from "@nyx/protocol";
import { SECTION_ORDER } from "@nyx/protocol";
import { ApprovalEngineImpl, PolicyEngineImpl } from "@nyx/policy";
import { MemoryStoreImpl } from "@nyx/memory";
import { ModelRouterImpl, ProviderRegistryImpl } from "@nyx/model";
import type { MockTurn } from "@nyx/model";
import { openSessionStore } from "@nyx/session";
import { createKernel } from "@nyx/kernel";
import { createToolRuntime, registerBuiltinTools, ToolRegistryImpl, ToolRouterImpl } from "@nyx/tools";
import {
  createSubagentManager,
  registerSubagentTool,
  resolveSubagentsConfig,
} from "@nyx/subagents";

/** Logger fake that swallows everything. */
export class QuietLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger {
    return this;
  }
}

/** Tmpdir-backed sandbox: real fs, no-op exec. */
export class TmpSandbox implements Sandbox {
  constructor(
    readonly id: string,
    readonly workdir: string,
  ) {}

  async exec(
    _cmd: string,
    _opts?: { cwd?: string; timeout_ms?: number; env?: Record<string, string> },
  ): Promise<ExecResult> {
    return { exit_code: 0, stdout: "", stderr: "", duration_ms: 0, truncated: false };
  }

  readFile(p: string): Promise<Buffer> {
    return fsp.readFile(path.isAbsolute(p) ? p : path.join(this.workdir, p));
  }

  async writeFile(p: string, data: Buffer | string): Promise<void> {
    const target = path.isAbsolute(p) ? p : path.join(this.workdir, p);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
  }

  async list(p: string): Promise<Array<{ name: string; type: "file" | "dir"; size: number }>> {
    const dir = path.join(this.workdir, p);
    const out: Array<{ name: string; type: "file" | "dir"; size: number }> = [];
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const stat = await fsp.stat(path.join(dir, entry.name));
      out.push({ name: entry.name, type: entry.isDirectory() ? "dir" : "file", size: stat.size });
    }
    return out;
  }

  async destroy(): Promise<void> {
    await fsp.rm(this.workdir, { recursive: true, force: true });
  }
}

/** Minimal persona: one section per SECTION_ORDER id. */
export function fakePersona(personaId = "eval-persona"): PersonaRuntime {
  return {
    persona_id: personaId,
    buildSystemPrompt(input: PromptAssemblyInput): PromptSection[] {
      return SECTION_ORDER.map((id) => ({
        id,
        title: id,
        body: `${id} body; ${input.tools_catalog.length} tools`,
      }));
    },
  };
}

/**
 * Scripted provider: pops one turn per complete() call, dispatching on an
 * optional marker inside the last user message (subagent children embed
 * their task; unmatched requests consume the fallback/parent queue).
 */
export class ScriptedProvider implements ModelProvider {
  readonly id = "mock";
  readonly requests: CompletionRequest[] = [];
  private readonly byMarker = new Map<string, MockTurn[]>();
  private readonly fallback: MockTurn[] = [];
  private readonly holdMsFor = new Map<string, number>();

  script(marker: string, turns: MockTurn[], holdMs = 0): this {
    this.byMarker.set(marker, [...turns]);
    if (holdMs > 0) this.holdMsFor.set(marker, holdMs);
    return this;
  }

  scriptParent(turns: MockTurn[]): this {
    this.fallback.push(...turns);
    return this;
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([{ id: "mock-1", context_window: 128000, max_output: 8192, supports: ["tools"] }]);
  }

  async *complete(req: CompletionRequest): AsyncGenerator<ModelChunk, void, void> {
    this.requests.push(req);
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
    let turn: MockTurn | undefined;
    let hold = 0;
    for (const [marker, turns] of this.byMarker) {
      if (text.includes(marker)) {
        turn = turns.shift();
        hold = this.holdMsFor.get(marker) ?? 0;
        break;
      }
    }
    if (turn === undefined) turn = this.fallback.shift();
    if (turn === undefined) {
      throw new Error("scripted provider: script exhausted");
    }
    if (!Array.isArray(turn)) {
      throw Object.assign(new Error(turn.fail.message), { name: turn.fail.name });
    }
    if (hold > 0) await new Promise((r) => setTimeout(r, hold));
    for (const chunk of turn) yield chunk;
  }
}

/** Approval engine with scripted outcomes; every decision lands as
 *  approval.requested + approval.resolved events on the session log,
 *  exactly the shapes the real surface emits. */
export class ScriptedApprovalEngine implements ApprovalEngine {
  private readonly outcomes: Array<"allow" | "deny">;
  private n = 0;
  readonly requested: Array<{ summary: string; risk: string }> = [];

  constructor(
    private readonly store: SessionStore,
    outcomes: Array<"allow" | "deny"> = [],
  ) {
    this.outcomes = [...outcomes];
  }

  async request(v: PolicyVerdict, ctx: ApprovalContext): Promise<"allow" | "deny"> {
    this.requested.push({ summary: v.summary, risk: "R2" });
    const decision = this.outcomes[this.n] ?? "deny";
    this.n += 1;
    const id = `approval-eval-${this.n}`;
    await this.store.append(ctx.session_id, [
      {
        type: "approval.requested",
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        approval_id: id,
        action_digest: v.action_digest,
        summary: v.summary,
        risk: "R2",
        ts: Date.now(),
      } as SessionEvent,
      {
        type: "approval.resolved",
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        approval_id: id,
        decision,
        decided_by: "eval:operator",
        ts: Date.now(),
      } as SessionEvent,
    ]);
    return decision;
  }

  async resolve(): Promise<ApprovalRecord> {
    throw new Error("not used by evals");
  }

  async get(): Promise<ApprovalRecord | null> {
    return null;
  }

  async pending(): Promise<ApprovalRecord[]> {
    return [];
  }

  async consume(): Promise<ApprovalRecord> {
    throw new Error("not used by evals");
  }
}

export interface FakeToolSpec {
  name: string;
  risk: "R0" | "R1" | "R2" | "R3" | "R4";
  capabilities?: string[];
  output?: ToolOutput;
  /** Hang for this many ms (abort tests). */
  hang_ms?: number;
  /** A handler override (memory.write writes through the real store). */
  handler?: ToolHandler;
}

export interface LoopSetup {
  provider_script: Array<
    { text: string } | { tool_call: { name: string; call_id?: string; input: Record<string, unknown> } }
  >;
  tools?: FakeToolSpec[];
  policy?: PolicyRule[];
  approval_decisions?: Array<"allow" | "deny">;
  engagement?: Engagement | null;
  seed_history?: { turns: number; tool_result_bytes: number };
  compaction_budget_tokens?: number;
  memory?: boolean;
  subagents?: { child_marker: string; child_script: Array<{ text: string }>; child_hold_ms?: number };
  abort_after_event?: string;
}

export interface LoopRunResult {
  events: SessionEvent[];
  memory_entries: MemoryEntry[];
  session_id: string;
  error?: string;
}

/** Convert the YAML provider script into MockTurn[]. */
export function toMockTurns(
  script: LoopSetup["provider_script"],
): MockTurn[] {
  return script.map((step) => {
    if ("text" in step) {
      return [
        { type: "text.delta", text: step.text },
        { type: "usage", usage: { input_tokens: 10, output_tokens: 10 } },
        { type: "done", finish_reason: "stop" },
      ];
    }
    const call = step.tool_call;
    return [
      {
        type: "tool_call.delta",
        index: 0,
        id: call.call_id ?? "c1",
        name: call.name,
        arguments_delta: JSON.stringify(call.input),
      },
      { type: "usage", usage: { input_tokens: 10, output_tokens: 10 } },
      { type: "done", finish_reason: "tool_calls" },
    ];
  });
}

export interface LoopRig {
  store: SessionStore;
  session: SessionMeta;
  memory: MemoryStoreImpl;
  run(userMessage: string): Promise<LoopRunResult>;
  close(): Promise<void>;
}

export async function runLoopEval(
  setup: LoopSetup,
  userMessage: string,
): Promise<LoopRunResult> {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-eval-"));
  const db = new Database(":memory:");
  const store = openSessionStore(":memory:", { db });
  const memory = new MemoryStoreImpl(path.join(baseDir, "memory"));
  const provider = new ScriptedProvider();
  provider.scriptParent(toMockTurns(setup.provider_script));
  if (setup.subagents !== undefined) {
    provider.script(
      setup.subagents.child_marker,
      toMockTurns(setup.subagents.child_script),
      setup.subagents.child_hold_ms ?? 0,
    );
  }

  const registry = new ToolRegistryImpl();
  registerBuiltinTools(registry);
  // Convention: a fake tool named "memory.write" writes through the REAL
  // memory store — the eval asserts the durable side effect, not the echo.
  for (const spec of setup.tools ?? []) {
    const memoryWriteHandler: ToolHandler | undefined =
      spec.name === "memory.write"
        ? {
            execute: async (call): Promise<ToolOutput> => {
              const entry = (call.input as { entry?: string }).entry ?? "";
              await memory.write({
                scope: "global",
                kind: "fact",
                content: entry,
                source: { session_id: session.session_id },
                tags: ["eval"],
              });
              return { kind: "text", text: "recorded" };
            },
          }
        : undefined;
    registry.register(
      {
        name: spec.name,
        description: `eval fake tool ${spec.name}`,
        input_schema: { type: "object", additionalProperties: true },
        risk: spec.risk,
        capabilities: (spec.capabilities ?? []) as never,
        handler: `eval:${spec.name}`,
      },
      spec.handler ??
        memoryWriteHandler ?? {
          execute: async (): Promise<ToolOutput> => {
            if (spec.hang_ms !== undefined && spec.hang_ms > 0) {
              await new Promise((r) => setTimeout(r, spec.hang_ms));
            }
            return spec.output ?? { kind: "text", text: `${spec.name} ok` };
          },
        },
    );
  }

  const policy = new PolicyEngineImpl(setup.policy ?? []);
  const approvals =
    setup.approval_decisions !== undefined
      ? new ScriptedApprovalEngine(store, setup.approval_decisions)
      : new ApprovalEngineImpl(db);
  const runtime = createToolRuntime({
    registry,
    router: new ToolRouterImpl(),
    policy,
    approvals,
  });

  const kernel = createKernel();
  kernel.services.set("tools.runtime", runtime);

  const session = await store.create({
    owner_id: "owner",
    persona_id: "eval-persona",
    engagement: setup.engagement ?? null,
  });

  // Seeded history: N completed turns whose tool_result blocks are large —
  // the documented compaction e2e recipe.
  if (setup.seed_history !== undefined) {
    // The documented recipe (tests/e2e/compaction.test.ts): tool_result
    // blocks ride INSIDE assistant messages — the durable shape the
    // projection turns into model-visible tool results.
    const filler = "x".repeat(setup.seed_history.tool_result_bytes);
    let ts = Date.now();
    for (let i = 0; i < setup.seed_history.turns; i += 1) {
      await store.append(session.session_id, [
        { type: "turn.started", session_id: session.session_id, turn_id: `seed-${i}`, ts: ts++ },
        {
          type: "message.user",
          session_id: session.session_id,
          turn_id: `seed-${i}`,
          content: [{ type: "text", text: `read big-${i}.txt` }],
          ts: ts++,
        },
        {
          type: "message.assistant",
          session_id: session.session_id,
          turn_id: `seed-${i}`,
          content: [{ type: "tool_use", call_id: `seed-${i}`, name: "fs.read", input: { path: `big-${i}.txt` } }],
          ts: ts++,
        },
        {
          type: "message.assistant",
          session_id: session.session_id,
          turn_id: `seed-${i}`,
          content: [{ type: "tool_result", call_id: `seed-${i}`, output: { kind: "text", text: filler } }],
          ts: ts++,
        },
        {
          type: "turn.completed",
          session_id: session.session_id,
          turn_id: `seed-${i}`,
          usage: { input_tokens: 100, output_tokens: 100 },
          ts: ts++,
        },
      ] as never);
    }
  }

  // The subagent manager (real; children run their own loop against the
  // same scripted provider via the marker dispatch).
  let subagents: ReturnType<typeof createSubagentManager> | undefined;
  if (setup.subagents !== undefined) {
    // "shared": the eval sandbox is a plain tmpdir (not forkable); the
    // fork mode is covered by the @nyx/subagents suite itself.
    const config = resolveSubagentsConfig({ sandbox_sharing: "inherit" });
    subagents = createSubagentManager({
      store,
      config,
      db,
      poll_ms: 25,
    });
    registerSubagentTool(registry, { manager: subagents, config });
  }

  const providerRegistry = new ProviderRegistryImpl();
  providerRegistry.register(provider);
  const router = new ModelRouterImpl(providerRegistry, {
    default: { chain: [{ provider: "mock", model: "mock-1" }] },
  });

  const sandbox = new TmpSandbox(`eval-${session.session_id}`, path.join(baseDir, "sandbox"));
  const controller = new AbortController();
  const logger = new QuietLogger();

  const ctx: RunContext = {
    kernel,
    session: store,
    model: router,
    tools: registry,
    tool_router: { select: (call, available) => available.find((d) => d.name === call.name) ?? null },
    policy,
    approvals,
    sandbox,
    memory,
    persona: fakePersona(),
    signal: controller.signal,
    logger,
    ...(setup.compaction_budget_tokens !== undefined
      ? { options: { compaction_budget_tokens: setup.compaction_budget_tokens } }
      : {}),
  };

  const turnId = `eval-turn-${Date.now()}`;
  if (subagents !== undefined) {
    // Bind THE turn the loop is about to run (same id), so the spawn tool
    // resolves its parent context.
    subagents.bindTurn(session.session_id, turnId, ctx);
  }

  const events: SessionEvent[] = [];
  let error: string | undefined;
  const { createAgentLoop } = await import("@nyx/agent");
  const loop = createAgentLoop();

  try {
    const abortAfter = setup.abort_after_event;
    for await (const event of loop.run(
      {
        session_id: session.session_id,
        turn_id: turnId,
        user_message: { role: "user", content: [{ type: "text", text: userMessage }] } as Message,
      },
      ctx,
    )) {
      events.push(event);
      if (abortAfter !== undefined && event.type === abortAfter) {
        controller.abort();
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const memoryEntries = await memory.list({ limit: 1000 });
  subagents?.unbindTurn(session.session_id);
  await sandbox.destroy().catch(() => undefined);
  // The event LOG is the store: engine-side appends (approval.requested,
  // mirrored subagent events) land there even when the loop's iterator has
  // already moved on. Assert on the log, not the iterator.
  const logEvents = await store.read(session.session_id, 1);
  await fsp.rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
  store.close();
  db.close();

  return { events: logEvents, memory_entries: memoryEntries, session_id: session.session_id, ...(error !== undefined ? { error } : {}) };
}
