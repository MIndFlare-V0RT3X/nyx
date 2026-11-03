// SPDX-License-Identifier: AGPL-3.0-or-later
// The CLI's local runtime: the full NYX stack composed in ONE process,
// mirroring apps/server/src/server.ts's wiring (the CLI may not import
// @nyx/server — the wiring is reimplemented here). Everything the agent loop
// needs is constructed once and shared: sink → approval-engine callbacks →
// kernel services → router/tools/policy/sandbox/persona/memory. The loop is
// driven exactly as every other surface drives it — the runtime only builds
// the RunContext and consumes the iterator; every event is appended to the
// store by the loop itself (through the sink-wrapped store) or by the
// approval engine's callbacks.
//
// Ordering contract: ALL appends to the session event log from this process
// route through the EventSink (single serialized writer), so the loop's
// events and the approval lifecycle events share one total order.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createKernel } from "@nyx/kernel";
import type { NyxConfig } from "@nyx/config";
import { openSessionStore } from "@nyx/session";
import { openApprovalEngine, PolicyEngineImpl } from "@nyx/policy";
import { MemoryStoreImpl } from "@nyx/memory";
import { loadPersona, PersonaRuntimeImpl } from "@nyx/persona";
import { ModelRouterImpl, ProviderRegistryImpl } from "@nyx/model";
import { DockerSandboxProvider, LocalSandboxProvider } from "@nyx/sandbox";
import {
  createToolRuntime,
  registerBuiltinTools,
  ToolRegistryImpl,
  ToolRouterImpl,
} from "@nyx/tools";
import { createAgentLoop } from "@nyx/agent";
import type {
  ApprovalEngine,
  ApprovalRecord,
  ContentBlock,
  Engagement,
  Logger,
  ModelProvider,
  PersonaRuntime,
  RunContext,
  Sandbox,
  SandboxProvider,
  SerializedError,
  SessionEvent,
  SessionMeta,
  SessionStore,
} from "@nyx/protocol";
import { toSerializedError } from "@nyx/protocol";
import { CliError } from "./errors.js";
import { createEventSink, type EventSink } from "./sink.js";
import { createCliLogger } from "./logger.js";
import { buildProviders } from "./providers.js";

/** Non-interactive safety: pending approvals are denied after this long. */
export const DEFAULT_AUTO_DENY_MS = 2_000;

/** The note printed when a non-interactive approval is auto-denied. */
export const AUTO_DENY_NOTE = "approval required in non-interactive mode — denied; use `nyx chat`";

export type ApprovalMode = "interactive" | "auto-deny";

export interface LocalRuntimeDeps {
  config: NyxConfig;
  /** Root for nyx.db / policy.db (created if missing). */
  data_dir: string;
  /** Test injection: replaces config-derived providers, registered by id. */
  providers?: ModelProvider[];
  /** Env source for provider api_key_env resolution (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** interactive (chat — a human resolves) or auto-deny (run — never block). */
  approval_mode?: ApprovalMode;
  /** Auto-deny delay in ms (default 2000). */
  auto_deny_ms?: number;
  /**
   * Approval lifecycle observer: fired with the approval.requested /
   * approval.resolved session event AND the engine record, after the event
   * has been appended through the sink. The chat TUI uses this to wake its
   * approval modal; the one-shot runner uses it to print the note.
   */
  on_approval_event?: (event: SessionEvent, record: ApprovalRecord) => void;
  /** Where the auto-deny note goes (default: stderr). */
  on_note?: (line: string) => void;
  /** Logger line sink override (tests). */
  log_sink?: { write(line: string): void };
}

export interface TurnInput {
  session_id: string;
  turn_id: string;
  content: ContentBlock[];
}

export interface TurnRunResult {
  /** Every event the loop yielded, in order (already stored). */
  events: SessionEvent[];
  completed: boolean;
  failed: boolean;
  /** A surface-level throw (missing persona, missing session): no events. */
  error: SerializedError | null;
}

export interface LocalRuntime {
  readonly config: NyxConfig;
  readonly store: SessionStore;
  readonly sink: EventSink;
  readonly approvals: ApprovalEngine;
  readonly toolRegistry: ToolRegistryImpl;
  readonly logger: Logger;
  /** All text streamed this turn, concatenated (deltas are not stored). */
  createSession(opts: {
    persona_id?: string;
    title?: string;
    engagement?: Engagement | null;
  }): Promise<SessionMeta>;
  meta(session_id: string): Promise<SessionMeta | null>;
  /** The per-session sandbox (provisioned once, cached). */
  sandboxFor(session_id: string): Promise<Sandbox>;
  /** Drive one turn through the agent loop; onEvent sees events live. */
  runTurn(input: TurnInput, onEvent?: (event: SessionEvent) => void): Promise<TurnRunResult>;
  pendingApprovals(session_id: string): Promise<ApprovalRecord[]>;
  resolveApproval(id: string, decision: "allow" | "deny"): Promise<ApprovalRecord>;
  abortSession(session_id: string): void;
  close(): Promise<void>;
}

export function createLocalRuntime(deps: LocalRuntimeDeps): LocalRuntime {
  const { config } = deps;

  // ── wiring (order matters: sink → engine callbacks → kernel services) ──
  mkdirSync(deps.data_dir, { recursive: true });
  const logger = createCliLogger(config.logging, { ...(deps.log_sink !== undefined ? { sink: deps.log_sink } : {}) });
  const store = openSessionStore(join(deps.data_dir, "nyx.db"));
  const sink = createEventSink(store);

  const approvalMode = deps.approval_mode ?? "interactive";
  const autoDenyMs = deps.auto_deny_ms ?? DEFAULT_AUTO_DENY_MS;
  const note = deps.on_note ?? ((line: string) => process.stderr.write(`${line}\n`));
  const autoDenyTimers = new Map<string, NodeJS.Timeout>();
  let closing = false;

  const appendApprovalEvent = (event: SessionEvent): void => {
    void sink.append(event.session_id, [event]).catch((err) => {
      logger.warn("approval.event_append_failed", { error: toSerializedError(err) });
    });
  };

  const approvalHandle = openApprovalEngine(join(deps.data_dir, "policy.db"), {
    onCreated: (rec) => {
      const event: SessionEvent = {
        type: "approval.requested",
        session_id: rec.session_id,
        turn_id: rec.turn_id,
        approval_id: rec.id,
        action_digest: rec.action_digest,
        summary: rec.summary,
        risk: rec.risk,
        ts: Date.now(),
      };
      appendApprovalEvent(event);
      deps.on_approval_event?.(event, rec);
      if (approvalMode === "auto-deny") {
        // Deny-first, never block: a script cannot answer an approval prompt,
        // so after the grace period the pending row is resolved deny. The
        // engine's request() poll (150ms) picks the decision up.
        const timer = setTimeout(() => {
          autoDenyTimers.delete(rec.id);
          void (async () => {
            try {
              const current = await approvalHandle.engine.get(rec.id);
              if (current === null || current.decision !== "pending") return;
              note(AUTO_DENY_NOTE);
              await approvalHandle.engine.resolve(rec.id, "deny", "cli:non-interactive");
            } catch (err) {
              logger.warn("approval.auto_deny_failed", {
                approval_id: rec.id,
                error: toSerializedError(err),
              });
            }
          })();
        }, autoDenyMs);
        autoDenyTimers.set(rec.id, timer);
      }
    },
    onResolved: (rec) => {
      const timer = autoDenyTimers.get(rec.id);
      if (timer !== undefined) {
        clearTimeout(timer);
        autoDenyTimers.delete(rec.id);
      }
      const event: SessionEvent = {
        type: "approval.resolved",
        session_id: rec.session_id,
        turn_id: rec.turn_id,
        approval_id: rec.id,
        decision: rec.decision === "pending" ? "deny" : rec.decision,
        decided_by: rec.decided_by ?? "system",
        ts: Date.now(),
      };
      appendApprovalEvent(event);
      deps.on_approval_event?.(event, rec);
    },
  });
  const approvals = approvalHandle.engine;

  const providers = deps.providers ?? buildProviders(config, logger, deps.env ?? process.env);
  const providerRegistry = new ProviderRegistryImpl();
  for (const provider of providers) providerRegistry.register(provider);
  const router = new ModelRouterImpl(
    providerRegistry,
    {
      default: config.router.default,
      rules: config.router.rules.map((rule) => ({
        task: rule.match.task,
        chain: rule.chain,
      })),
    },
    logger.child({ component: "router" }),
    config.router.budgets,
  );

  const toolRouter = new ToolRouterImpl();
  const kernel = createKernel();
  const toolRegistry = new ToolRegistryImpl();
  registerBuiltinTools(toolRegistry);
  const policy = new PolicyEngineImpl(config.policy.rules);
  const toolRuntime = createToolRuntime({
    registry: toolRegistry,
    router: toolRouter,
    policy,
    approvals,
  });
  kernel.services.set("tools.runtime", toolRuntime);

  const memory = new MemoryStoreImpl(config.memory.root, {
    episode_expiry_days: config.memory.episode_expiry_days,
  });

  const personas = new Map<string, PersonaRuntime>();
  const personaFor = async (id: string): Promise<PersonaRuntime> => {
    const cached = personas.get(id);
    if (cached !== undefined) return cached;
    const loaded = await loadPersona(config.persona.root, id);
    const runtime = new PersonaRuntimeImpl(loaded);
    personas.set(id, runtime);
    return runtime;
  };

  const sandboxProvider: SandboxProvider =
    config.sandbox.provider === "local"
      ? new LocalSandboxProvider({ root: config.sandbox.workdir_root })
      : new DockerSandboxProvider({ image: config.sandbox.image });
  const sessionSandboxes = new Map<string, Sandbox>();
  const sandboxFor = async (session_id: string): Promise<Sandbox> => {
    const cached = sessionSandboxes.get(session_id);
    if (cached !== undefined) return cached;
    const sandbox = await sandboxProvider.provision({
      provider: config.sandbox.provider,
      workdir: join(config.sandbox.workdir_root, session_id),
      image: config.sandbox.image,
      network: "none",
    });
    sessionSandboxes.set(session_id, sandbox);
    return sandbox;
  };

  const loop = createAgentLoop();
  const turnControllers = new Map<string, AbortController>();

  const runTurn = async (
    input: TurnInput,
    onEvent?: (event: SessionEvent) => void,
  ): Promise<TurnRunResult> => {
    const controller = new AbortController();
    turnControllers.set(input.session_id, controller);
    const log = logger.child({ session_id: input.session_id, turn_id: input.turn_id, component: "turn" });
    const events: SessionEvent[] = [];
    let completed = false;
    let failed = false;
    let error: SerializedError | null = null;
    try {
      const meta = await store.meta(input.session_id);
      if (meta === null) {
        throw new CliError("not_found", `session ${input.session_id} not found`);
      }
      const ctx: RunContext = {
        kernel,
        session: sink.wrapped,
        model: router,
        tools: toolRegistry,
        tool_router: toolRouter,
        policy,
        approvals,
        sandbox: await sandboxFor(input.session_id),
        memory,
        persona: await personaFor(meta.persona_id),
        signal: controller.signal,
        logger: log,
      };
      for await (const event of loop.run(
        { session_id: input.session_id, turn_id: input.turn_id, user_message: { role: "user", content: input.content } },
        ctx,
      )) {
        // The loop appended every event to the store through the sink before
        // yielding it; the CLI is only the renderer.
        events.push(event);
        if (event.type === "turn.completed") completed = true;
        if (event.type === "turn.failed") failed = true;
        onEvent?.(event);
      }
    } catch (err) {
      // The loop emits turn.failed for in-turn errors; a throw here is a
      // surface defect (missing persona, broken service) — report it as the
      // turn's failure instead of swallowing it.
      log.error("turn.threw", { error: toSerializedError(err) });
      error = toSerializedError(err);
    } finally {
      turnControllers.delete(input.session_id);
    }
    return { events, completed, failed, error };
  };

  return {
    config,
    store,
    sink,
    approvals,
    toolRegistry,
    logger,
    createSession: async (opts) => {
      const persona_id = opts.persona_id ?? config.persona.default_id;
      try {
        await personaFor(persona_id);
      } catch (err) {
        throw new CliError(
          "validation_failed",
          `unknown persona "${persona_id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return store.create({
        owner_id: config.owner_id,
        persona_id,
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        engagement: opts.engagement ?? null,
      });
    },
    meta: (session_id) => store.meta(session_id),
    sandboxFor,
    runTurn,
    pendingApprovals: (session_id) => approvals.pending(session_id),
    resolveApproval: (id, decision) => approvals.resolve(id, decision, config.owner_id),
    abortSession: (session_id) => {
      const controller = turnControllers.get(session_id);
      if (controller !== undefined) controller.abort();
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const timer of autoDenyTimers.values()) clearTimeout(timer);
      autoDenyTimers.clear();
      for (const controller of turnControllers.values()) controller.abort();
      turnControllers.clear();
      // Session sandboxes are intentionally NOT destroyed: a CLI process is
      // short-lived and its workdir holds the turn's side effects (fs.write
      // outputs, artifacts) that the operator may still want to read —
      // sandbox GC is a deferred item. The server destroys its sandboxes on
      // shutdown; the CLI keeps them under config.sandbox.workdir_root.
      store.close();
      approvalHandle.close();
    },
  };
}
