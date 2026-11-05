// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared test harness for the @nyx/subagents suite. This file is a HELPER,
// not a suite: named *.test.ts so the root eslint config's package-boundary
// exemption applies (only tests may import sibling @nyx packages), excluded
// from the vitest run because it registers no tests.
//
// Real components: openSessionStore(":memory:"), ModelRouterImpl over a
// marker-dispatching scripted provider (each child's turns are keyed by a
// unique task marker, the parent's by a fallback queue), the REAL
// @nyx/tools runtime + registry with builtin tools, a real kernel, real
// PolicyEngineImpl + ApprovalEngineImpl, a real MemoryStoreImpl on a tmpdir,
// and a tmpdir-backed sandbox. The manager under test is real; only the
// model is scripted.

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll } from "vitest";
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
import {
  SECTION_ORDER,
  type CompletionRequest,
  type ExecResult,
  type Logger,
  type ModelChunk,
  type ModelInfo,
  type ModelProvider,
  type PersonaRuntime,
  type PromptAssemblyInput,
  type PromptSection,
  type RunContext,
  type Sandbox,
  type SessionMeta,
  type SessionStore,
  type ToolHandler,
} from "@nyx/protocol";
import {
  createSubagentManager,
  registerSubagentTool,
  resolveSubagentsConfig,
  type SubagentManager,
  type SubagentsConfig,
} from "./index.js";

/** Logger fake that swallows (and records) everything. */
export class QuietLogger implements Logger {
  readonly entries: Array<{ level: string; msg: string }> = [];
  debug(msg: string): void {
    this.entries.push({ level: "debug", msg });
  }
  info(msg: string): void {
    this.entries.push({ level: "info", msg });
  }
  warn(msg: string): void {
    this.entries.push({ level: "warn", msg });
  }
  error(msg: string): void {
    this.entries.push({ level: "error", msg });
  }
  child(): Logger {
    return this;
  }
}

/** Tmpdir-backed sandbox: real fs for read/write/list, no-op exec. */
export class TmpSandbox implements Sandbox {
  readonly id: string;
  readonly workdir: string;

  constructor(id: string, workdir: string) {
    this.id = id;
    this.workdir = workdir;
  }

  async exec(
    _cmd: string,
    _opts?: { cwd?: string; timeout_ms?: number; env?: Record<string, string> },
  ): Promise<ExecResult> {
    return { exit_code: 0, stdout: "", stderr: "", duration_ms: 0, truncated: false };
  }

  readFile(p: string): Promise<Buffer> {
    return fsp.readFile(this.resolve(p));
  }

  async writeFile(p: string, data: Buffer | string): Promise<void> {
    const target = this.resolve(p);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
  }

  async list(p: string): Promise<Array<{ name: string; type: "file" | "dir"; size: number }>> {
    const dir = this.resolve(p);
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

  private resolve(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.workdir, p);
  }
}

/**
 * Scripted provider that dispatches on a marker inside the LAST user message
 * (the child's initial message embeds its task; tests give each child a task
 * with a unique marker). Unmatched requests consume the fallback queue — the
 * parent session's script. Every request is recorded so tests can assert on
 * what the model was actually offered (e.g. the child's tools catalog).
 */
export class TaskDispatchProvider implements ModelProvider {
  readonly id = "mock";
  /** Every CompletionRequest seen, in order (model-facing surface proof). */
  readonly requests: CompletionRequest[] = [];
  private readonly byMarker = new Map<string, MockTurn[]>();
  private readonly fallback: MockTurn[] = [];
  private readonly holds = new Map<string, number>();

  constructor(models?: ModelInfo[]) {
    this.models = models ?? [
      { id: "mock-1", context_window: 128000, max_output: 8192, supports: ["tools"] },
    ];
  }

  private models: ModelInfo[];

  /** Script the turns for every request whose last user message contains `marker`.
   * `holdMs` sleeps before the marker's turn yields — gives a scripted child a
   * real duration (parallel-window and running-eviction tests). */
  script(marker: string, turns: MockTurn[], holdMs = 0): this {
    this.byMarker.set(marker, [...turns]);
    if (holdMs > 0) this.holds.set(marker, holdMs);
    return this;
  }

  /** Script the fallback queue (parent session requests). */
  scriptParent(turns: MockTurn[]): this {
    this.fallback.push(...turns);
    return this;
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([...this.models]);
  }

  async *complete(req: CompletionRequest): AsyncGenerator<ModelChunk, void, void> {
    this.requests.push(req);
    const { turn, hold } = this.nextTurn(req);
    if (turn === undefined) {
      throw new Error("task-dispatch provider: script exhausted");
    }
    if (!Array.isArray(turn)) {
      throw Object.assign(new Error(turn.fail.message), { name: turn.fail.name });
    }
    if (hold > 0) await new Promise((r) => setTimeout(r, hold));
    for (const chunk of turn) yield chunk;
  }

  private nextTurn(req: CompletionRequest): { turn: MockTurn | undefined; hold: number } {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
    for (const marker of this.byMarker.keys()) {
      if (text.includes(marker)) {
        return { turn: this.byMarker.get(marker)!.shift(), hold: this.holds.get(marker) ?? 0 };
      }
    }
    return { turn: this.fallback.shift(), hold: 0 };
  }
}

/** Minimal persona: one section per SECTION_ORDER id. */
export function fakePersona(personaId = "test-persona"): PersonaRuntime {
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

export interface SubagentHarnessOptions {
  config?: Partial<SubagentsConfig>;
  /** Extra tools registered alongside the builtins (e.g. slow test tools). */
  extraTools?: Array<{ name: string; handler: ToolHandler; risk?: "R0" | "R1" | "R2" | "R3" }>;
  /** Register the spawn_subagent tool (default true). */
  registerSpawnTool?: boolean;
  /** Use this provider instead of a fresh one (e.g. a slow-stream subclass). */
  provider?: TaskDispatchProvider;
  /** Extra SubagentManagerDeps merged over the defaults (db, poll_ms, hooks). */
  managerDeps?: Record<string, unknown>;
  /** Phase 4 §4: use this sandbox as the PARENT's (fork tests: a real provider). */
  parentSandbox?: Sandbox;
}

export interface SubagentHarness {
  store: SessionStore;
  parent: SessionMeta;
  parentCtx: RunContext;
  parentController: AbortController;
  manager: SubagentManager;
  config: SubagentsConfig;
  provider: TaskDispatchProvider;
  toolRegistry: ToolRegistryImpl;
  memory: MemoryStoreImpl;
  sandbox: TmpSandbox;
  kernel: ReturnType<typeof createKernel>;
  /** action.after hook captures: RunContext per session (child wiring proof). */
  capturedContexts: Map<string, RunContext>;
  makeParentCtx(signal?: AbortSignal): RunContext;
  close(): Promise<void>;
}

const live: SubagentHarness[] = [];

export async function makeSubagentHarness(
  opts: SubagentHarnessOptions = {},
): Promise<SubagentHarness> {
  const store = openSessionStore(":memory:");
  const parent = await store.create({ owner_id: "test-owner", persona_id: "test-persona" });

  const provider = opts.provider ?? new TaskDispatchProvider();
  const registry = new ProviderRegistryImpl();
  registry.register(provider);
  const model = new ModelRouterImpl(registry, {
    default: { chain: [{ provider: "mock", model: "mock-1" }] },
  });

  const db = new Database(":memory:");
  const approvals = new ApprovalEngineImpl(db, { poll_ms: 5 });
  // Deny-first: with zero rules every action escalates to "ask" and the
  // approval engine would block on TTL. Allow R0/R1 (the e2e convention);
  // risky tools still ask.
  const policy = new PolicyEngineImpl([
    { id: "test:allow-r0", match: { risk: "R0" }, decision: "allow" },
    { id: "test:allow-r1", match: { risk: "R1" }, decision: "allow" },
  ]);
  const toolRegistry = new ToolRegistryImpl();
  registerBuiltinTools(toolRegistry);
  for (const extra of opts.extraTools ?? []) {
    toolRegistry.register(
      {
        name: extra.name,
        description: `test tool ${extra.name}`,
        input_schema: { type: "object" },
        risk: extra.risk ?? "R0",
        capabilities: [],
        handler: `builtin:${extra.name}`,
      },
      extra.handler,
    );
  }
  const runtime = createToolRuntime({
    registry: toolRegistry,
    router: new ToolRouterImpl(),
    policy,
    approvals,
  });
  const kernel = createKernel();
  kernel.services.set("tools.runtime", runtime);

  const memDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-subagent-mem-"));
  const memory = new MemoryStoreImpl(memDir);
  const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-subagent-sbx-"));
  await fsp.writeFile(path.join(workdir, "hello.txt"), "shared sandbox file", "utf8");
  const sandbox = new TmpSandbox("sbx-parent", workdir);

  // Phase 4 §4: the config default flipped to "fork", but this harness's
  // TmpSandbox fake is not forkable — the inherit-semantics suites pin
  // "inherit" explicitly. Fork behavior has its own suite (fork.test.ts)
  // against the REAL local provider.
  const harnessConfig = { sandbox_sharing: "inherit" as const, ...opts.config };
  const config = resolveSubagentsConfig(harnessConfig);
  const manager = createSubagentManager({
    store,
    config: harnessConfig,
    ...(opts.managerDeps as object | undefined),
  });
  if (opts.registerSpawnTool !== false) {
    registerSubagentTool(toolRegistry, { manager, config });
  }

  const capturedContexts = new Map<string, RunContext>();
  kernel.hooks.on("action.after", (_output, action, ctx) => {
    capturedContexts.set(action.session_id, ctx);
    return Promise.resolve(undefined);
  });

  const logger = new QuietLogger();
  const parentController = new AbortController();
  const parentSandbox = opts.parentSandbox ?? sandbox;
  const makeParentCtx = (signal?: AbortSignal): RunContext => ({
    kernel,
    session: store,
    model,
    tools: toolRegistry,
    tool_router: new ToolRouterImpl(),
    policy,
    approvals,
    sandbox: parentSandbox,
    memory,
    persona: fakePersona(),
    signal: signal ?? parentController.signal,
    logger,
  });
  const parentCtx = makeParentCtx();

  const harness: SubagentHarness = {
    store,
    parent,
    parentCtx,
    parentController,
    manager,
    config,
    provider,
    toolRegistry,
    memory,
    sandbox,
    kernel,
    capturedContexts,
    makeParentCtx,
    close: async () => {
      db.close(); // the ApprovalEngineImpl shares this handle (engine has no close)
      memory.close();
      store.close();
      await sandbox.destroy();
      await fsp.rm(memDir, { recursive: true, force: true });
    },
  };
  live.push(harness);
  return harness;
}

afterAll(async () => {
  while (live.length > 0) {
    const harness = live.pop();
    await harness?.close();
  }
});
