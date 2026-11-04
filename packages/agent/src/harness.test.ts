// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared test harness for the agent-loop suite. This file is a HELPER, not a
// suite: it is named *.test.ts because the root eslint config exempts only
// test files from the package import boundaries (the harness needs the real
// @nyx/model router, @nyx/session store and @nyx/policy approval engine), and
// vitest.config.ts excludes it from the run because it registers no tests.
//
// Real components: openSessionStore(":memory:"), a ModelRouterImpl routing to
// a scripted MockProvider wrapped in a recording decorator, and a real
// ApprovalEngineImpl + PolicyEngineImpl on a :memory: better-sqlite3 db.
// Hand-rolled fakes: the kernel (working priority HookBus + service
// registry), tool registry, tmpdir-backed sandbox, Map-backed memory store,
// and a scriptable tool runtime installed as the kernel's "tools.runtime"
// service.

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// @ts-expect-error better-sqlite3 is not a declared dependency of @nyx/agent; tests resolve it from the sibling @nyx/policy workspace (tests are exempt from package import boundaries per the package brief).
import Database from "../../policy/node_modules/better-sqlite3";
import { ApprovalEngineImpl, PolicyEngineImpl } from "@nyx/policy";
import { MockProvider, ModelRouterImpl, ProviderRegistryImpl } from "@nyx/model";
import { openSessionStore } from "@nyx/session";
import { SECTION_ORDER } from "@nyx/protocol";
import type {
  AgentLoop,
  AgentOptions,
  ApprovalRecord,
  CompletionRequest,
  ExecResult,
  HookBus,
  HookMap,
  HookName,
  Kernel,
  Logger,
  MemoryEntry,
  MemoryScope,
  MemorySearchOptions,
  MemoryStore,
  ModelChunk,
  ModelInfo,
  ModelProvider,
  PersonaRuntime,
  PromptAssemblyInput,
  PromptSection,
  RunContext,
  RunInput,
  Sandbox,
  ServiceRegistry,
  SessionEvent,
  SessionMeta,
  SessionStore,
  ToolCall,
  ToolDefinition,
  ToolHandler,
  ToolRegistry,
  ToolRouter,
} from "@nyx/protocol";
import type { MockTurn } from "@nyx/model";
import { createAgentLoop } from "./loop.js";
import type {
  ToolRuntimeExecuteContext,
  ToolRuntimeExecuteOptions,
  ToolRuntimeService,
} from "./tool-runtime.js";

/** Logger fake that records entries so tests can assert on warn/error calls. */
export class RecordingLogger implements Logger {
  readonly entries: Array<{ level: "debug" | "info" | "warn" | "error"; msg: string }> = [];

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

/**
 * Priority HookBus: emit() invokes matching hooks highest-priority-first
 * (registration order breaks ties) and returns every result in that order,
 * void results included as undefined entries. Also counts emit() calls per
 * hook name so tests can assert how often the loop consulted a hook.
 */
export class FakeHookBus implements HookBus {
  readonly emissions = new Map<HookName, number>();
  private seq = 0;
  private readonly regs: Array<{
    name: HookName;
    priority: number;
    seq: number;
    run: (args: unknown[]) => Promise<unknown>;
  }> = [];

  on<K extends HookName>(
    name: K,
    fn: HookMap[K],
    opts?: { priority?: number; plugin?: string },
  ): () => void {
    const entry = {
      name,
      priority: opts?.priority ?? 0,
      seq: this.seq++,
      run: (args: unknown[]): Promise<unknown> =>
        Promise.resolve(fn(...(args as Parameters<HookMap[K]>))),
    };
    this.regs.push(entry);
    return () => {
      const i = this.regs.indexOf(entry);
      if (i >= 0) this.regs.splice(i, 1);
    };
  }

  async emit<K extends HookName>(
    name: K,
    ...args: Parameters<HookMap[K]>
  ): Promise<Array<Awaited<ReturnType<HookMap[K]>>>> {
    this.emissions.set(name, (this.emissions.get(name) ?? 0) + 1);
    const matching = this.regs
      .filter((r) => r.name === name)
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    const results: unknown[] = [];
    for (const reg of matching) {
      results.push(await reg.run(args));
    }
    return results as Array<Awaited<ReturnType<HookMap[K]>>>;
  }
}

/** Map-based ServiceRegistry. */
export class FakeServiceRegistry implements ServiceRegistry {
  private readonly services = new Map<string, unknown>();

  get<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  set(name: string, service: unknown): void {
    this.services.set(name, service);
  }

  has(name: string): boolean {
    return this.services.has(name);
  }

  delete(name: string): void {
    this.services.delete(name);
  }
}

/** Map-based ToolRegistry; definitions only (the fake runtime bypasses handlers). */
export class FakeToolRegistry implements ToolRegistry {
  private readonly entries = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();

  register(def: ToolDefinition, handler: ToolHandler): void {
    this.entries.set(def.name, { def, handler });
  }

  unregister(name: string): void {
    this.entries.delete(name);
  }

  list(): ToolDefinition[] {
    return [...this.entries.values()].map((e) => e.def);
  }

  get(name: string): { def: ToolDefinition; handler: ToolHandler } | null {
    return this.entries.get(name) ?? null;
  }
}

/** Tmpdir-backed sandbox: real fs for read/write/list, no-op exec. */
export class TmpSandbox implements Sandbox {
  readonly id: string;
  readonly workdir: string;
  private destroyed = false;

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
      out.push({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file",
        size: stat.size,
      });
    }
    return out;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await fsp.rm(this.workdir, { recursive: true, force: true });
  }

  private resolve(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.workdir, p);
  }
}

/** Map-backed MemoryStore implementing the five protocol methods. */
export class FakeMemoryStore implements MemoryStore {
  private nextId = 0;
  private readonly entries = new Map<string, MemoryEntry>();

  async write(entry: Omit<MemoryEntry, "id" | "created_at" | "updated_at">): Promise<MemoryEntry> {
    const now = Date.now();
    const full: MemoryEntry = {
      ...entry,
      id: `mem-${++this.nextId}`,
      created_at: now,
      updated_at: now,
    };
    this.entries.set(full.id, full);
    return full;
  }

  async search(
    query: string,
    opts?: MemorySearchOptions,
  ): Promise<Array<MemoryEntry & { score: number }>> {
    const hits = (await this.list(opts)).filter((m) => m.content.includes(query));
    return hits.map((m) => ({ ...m, score: 1 }));
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async list(opts?: {
    scope?: MemoryScope[];
    kind?: MemoryEntry["kind"];
    limit?: number;
  }): Promise<MemoryEntry[]> {
    const scope = opts?.scope;
    const kind = opts?.kind;
    const limit = opts?.limit;
    let out = [...this.entries.values()];
    if (scope !== undefined) out = out.filter((m) => scope.includes(m.scope));
    if (kind !== undefined) out = out.filter((m) => m.kind === kind);
    if (limit !== undefined) out = out.slice(0, limit);
    return out;
  }

  async compact(): Promise<{ merged: number; dropped: number }> {
    return { merged: 0, dropped: 0 };
  }
}

/**
 * Persona fake: exactly one tiny section per SECTION_ORDER id. The body
 * echoes the tools-catalog size so tests can see prompt-assembly inputs flow
 * through.
 */
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

/**
 * Provider decorator that records every CompletionRequest (AbortSignal
 * stripped — it is not structured-cloneable) before delegating to the
 * scripted MockProvider.
 */
export class RecordingProvider implements ModelProvider {
  readonly id: string;
  readonly requests: CompletionRequest[] = [];
  private readonly inner: ModelProvider;

  constructor(id: string, inner: ModelProvider) {
    this.id = id;
    this.inner = inner;
  }

  /** Number of model calls that reached the provider. */
  get calls(): number {
    return this.requests.length;
  }

  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }

  async *complete(req: CompletionRequest): AsyncGenerator<ModelChunk, void, void> {
    const { signal: _signal, ...cloneable } = req;
    this.requests.push(structuredClone(cloneable));
    yield* this.inner.complete(req);
  }
}

export type FakeToolHandler = (
  call: ToolCall,
  ctx: ToolRuntimeExecuteContext,
) => ToolOutput | Promise<ToolOutput>;

export interface RecordedToolCall {
  call: ToolCall;
  ctx: ToolRuntimeExecuteContext;
  opts: ToolRuntimeExecuteOptions | undefined;
}

/**
 * Scriptable "tools.runtime" service: records every execute() call (call,
 * ctx, opts) and emits the same tool.call/tool.result events the real
 * @nyx/tools runtime emits, delegating the actual work to a per-test handler
 * (default: text "ok").
 */
export class FakeToolRuntime implements ToolRuntimeService {
  readonly calls: RecordedToolCall[] = [];
  private handler: FakeToolHandler = async () => ({ kind: "text", text: "ok" });

  setHandler(handler: FakeToolHandler): void {
    this.handler = handler;
  }

  async execute(
    call: ToolCall,
    ctx: ToolRuntimeExecuteContext,
    opts?: ToolRuntimeExecuteOptions,
  ): Promise<ToolOutput> {
    this.calls.push({ call, ctx, opts });
    ctx.emit({
      type: "tool.call",
      session_id: ctx.session_id,
      turn_id: ctx.turn_id,
      call_id: call.call_id,
      name: call.name,
      input: call.input,
      ts: Date.now(),
    });
    const output = await this.handler(call, ctx);
    ctx.emit({
      type: "tool.result",
      session_id: ctx.session_id,
      turn_id: ctx.turn_id,
      call_id: call.call_id,
      output,
      ts: Date.now(),
    });
    return output;
  }
}

/** ToolRouter fake: name-based selection over the available definitions. */
export const fakeToolRouter: ToolRouter = {
  select: (call, available) => available.find((d) => d.name === call.name) ?? null,
};

/** Kernel fake: working HookBus + ServiceRegistry; plugin (un)registration is unused by the loop. */
export class FakeKernel implements Kernel {
  readonly hooks = new FakeHookBus();
  readonly services = new FakeServiceRegistry();
  readonly tools: ToolRegistry;
  readonly version = "test-kernel";

  constructor(tools: ToolRegistry) {
    this.tools = tools;
  }

  async use(): Promise<void> {
    throw new Error("FakeKernel.use is not implemented");
  }

  async unuse(_name: string): Promise<void> {
    throw new Error("FakeKernel.unuse is not implemented");
  }
}

export interface HarnessOptions {
  /** MockProvider script; one turn is consumed per model call. */
  script?: MockTurn[];
  /** Tool definitions to register (most tests run with zero tools). */
  tools?: ToolDefinition[];
  /** ctx.options: max_tool_rounds / compaction_budget_tokens. */
  options?: AgentOptions;
  /** AbortSignal for the run; default: a fresh, un-aborted controller. */
  signal?: AbortSignal;
  /** Register the fake runtime as kernel service "tools.runtime" (default true). */
  registerRuntime?: boolean;
  /** Memories visible to prompt assembly. */
  memories?: Array<Omit<MemoryEntry, "id" | "created_at" | "updated_at">>;
}

export interface Harness {
  ctx: RunContext;
  kernel: FakeKernel;
  loop: AgentLoop;
  runtimeSpy: FakeToolRuntime;
  provider: RecordingProvider;
  mock: MockProvider;
  store: SessionStore;
  session: SessionMeta;
  logger: RecordingLogger;
  approvals: ApprovalEngineImpl;
  /** Approval-lifecycle records surfaced by the engine callbacks (empty in loop tests — the fake runtime bypasses approvals). */
  approvalLog: { requested: ApprovalRecord[]; resolved: ApprovalRecord[] };
  /** Builds a RunInput for this harness's session. */
  input(turnId?: string, text?: string): RunInput;
  /** Drives the loop to completion, collecting every yielded event. Re-throws typed loop errors. */
  run(input?: RunInput): Promise<SessionEvent[]>;
}

const live: Harness[] = [];
const openDbs: Array<{ close(): void }> = [];

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const store = openSessionStore(":memory:");
  const session = await store.create({ owner_id: "test-owner", persona_id: "test-persona" });

  const mock = new MockProvider("mock", opts.script ?? []);
  const provider = new RecordingProvider("mock", mock);
  const registry = new ProviderRegistryImpl();
  registry.register(provider);
  const model = new ModelRouterImpl(registry, {
    default: { chain: [{ provider: "mock", model: "mock-1" }] },
  });

  // Real approval engine on a private :memory: db. The fake tool runtime
  // never consults it, but the RunContext carries the wiring a surface owns.
  const db = new Database(":memory:");
  openDbs.push(db);
  const approvalLog = { requested: [] as ApprovalRecord[], resolved: [] as ApprovalRecord[] };
  const approvals = new ApprovalEngineImpl(db, {
    poll_ms: 5,
    onCreated: (rec) => {
      approvalLog.requested.push(rec);
    },
    onResolved: (rec) => {
      approvalLog.resolved.push(rec);
    },
  });

  const tools = new FakeToolRegistry();
  const stubHandler: ToolHandler = { execute: async () => ({ kind: "text", text: "" }) };
  for (const def of opts.tools ?? []) tools.register(def, stubHandler);

  const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-agent-test-"));
  const sandbox = new TmpSandbox("sbx-test", workdir);

  const memory = new FakeMemoryStore();
  for (const entry of opts.memories ?? []) await memory.write(entry);

  const kernel = new FakeKernel(tools);
  const runtimeSpy = new FakeToolRuntime();
  if (opts.registerRuntime !== false) kernel.services.set("tools.runtime", runtimeSpy);

  const controller = new AbortController();
  const logger = new RecordingLogger();
  const ctx: RunContext = {
    kernel,
    session: store,
    model,
    tools,
    tool_router: fakeToolRouter,
    policy: new PolicyEngineImpl([]),
    approvals,
    sandbox,
    memory,
    persona: fakePersona(),
    signal: opts.signal ?? controller.signal,
    logger,
    options: opts.options,
  };

  const loop = createAgentLoop();
  const harness: Harness = {
    ctx,
    kernel,
    loop,
    runtimeSpy,
    provider,
    mock,
    store,
    session,
    logger,
    approvals,
    approvalLog,
    input(turnId = "t1", text = "please continue") {
      return {
        session_id: session.session_id,
        turn_id: turnId,
        user_message: { role: "user", content: [{ type: "text", text }] },
      };
    },
    async run(input) {
      const events: SessionEvent[] = [];
      for await (const event of loop.run(input ?? harness.input(), ctx)) {
        events.push(event);
      }
      return events;
    },
  };
  live.push(harness);
  return harness;
}

/** Closes every harness created in this test file (call from afterAll). */
export async function closeAllHarnesses(): Promise<void> {
  while (live.length > 0) {
    const harness = live.pop();
    if (harness === undefined) break;
    await harness.ctx.sandbox.destroy();
    harness.store.close();
  }
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    db?.close();
  }
}
