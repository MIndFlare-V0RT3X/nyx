// SPDX-License-Identifier: AGPL-3.0-or-later
// The NYX app server: one Hono app wiring the full runtime (stores, policy,
// sandbox, tools, persona, router, loop) behind the REST/SSE/WS contract in
// docs/PROTOCOL.md. The agent loop is driven exactly as every other surface
// drives it — the server only constructs the RunContext and consumes the
// loop's iterator; every event is appended to the store by the loop itself
// (through the sink-wrapped store) or by the approval engine's callbacks.
//
// Ordering contract: ALL appends to the session event log from this process
// route through the EventSink (single serialized writer), so the loop's
// events and the approval lifecycle events share one total order.

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import { createKernel } from "@nyx/kernel";
import { BRAND, type NyxConfig } from "@nyx/config";
import { openUnifiedDatabase } from "@nyx/db";
import { openSessionStore, archivePathOf } from "@nyx/session";
import { openApprovalEngine, PolicyEngineImpl } from "@nyx/policy";
import { EngagementOwnershipError, assertEngagementOwnership } from "@nyx/policy";
import { auditEngagementCreated } from "@nyx/policy";
import type { DnsResolver } from "@nyx/policy";
import { MemoryStoreImpl } from "@nyx/memory";
import { loadPersona, PersonaRuntimeImpl } from "@nyx/persona";
import { ModelRouterImpl, ProviderRegistryImpl } from "@nyx/model";
import { DockerSandboxProvider, checkDocker, LocalSandboxProvider } from "@nyx/sandbox";
import {
  createToolRuntime,
  registerBuiltinTools,
  ToolRegistryImpl,
  ToolRouterImpl,
} from "@nyx/tools";
import { createAgentLoop } from "@nyx/agent";
import { COMPACTION_SERVICE, createCompactionPipeline } from "@nyx/agent";
import {
  createSubagentManager,
  registerSubagentArtifactTools,
  registerSubagentTool,
  resolveSubagentsConfig,
  type SubagentManager,
} from "@nyx/subagents";
import { createLaneQueue, createHeartbeatScheduler, HeartbeatStore } from "@nyx/runtime";
import type { LaneQueue, Scheduler } from "@nyx/runtime";
import {
  createTaskManager,
  ensureRetentionTask,
  isSystemTaskId,
  runRetentionAttempt,
  TaskWorkerPool,
  type TaskManager,
  type TaskRunner,
} from "@nyx/tasks";
import {
  ChannelManager,
  ChannelSessionStore,
  TelegramApprovalBridge,
  TelegramChannel,
  WebhookApprovalPresenter,
  WebhookChannel,
  createHttpTelegramClient,
  replyTextFromEvents,
} from "@nyx/channels";
import type {
  ChannelAdapter,
  ChannelTurnHandle,
  ChannelTurnRunner,
  TelegramClient,
} from "@nyx/channels";
import {
  ContentBlockSchema,
  EngagementSchema,
  TaskSpecSchema,
  toSerializedError,
  type ContentBlock,
  type ModelProvider,
  type PersonaRuntime,
  type ApprovalEngine,
  type RunContext,
  type Sandbox,
  type SandboxProvider,
  type SessionEvent,
  type StoredEvent,
  type TaskRecord,
  type TaskState,
} from "@nyx/protocol";
import { validateTargets } from "@nyx/scope";
import { authenticate, resolveAuth, type Actor, type ResolvedAuth } from "./auth.js";
import { createEventSink } from "./eventsink.js";
import { createLogger } from "./logger.js";
import { buildProviders } from "./providers.js";
import { SERVER_ID } from "./version.js";
import { injectWebSocketServer, type WebSocketHub } from "./ws.js";

export interface ServerDeps {
  config: NyxConfig;
  /** Root for nyx.db (created if missing). */
  data_dir: string;
  /** Test injection: replaces config-derived providers, registered by id. */
  providers?: ModelProvider[];
  /**
   * 2.0.4 test injection: replaces the OS resolver used for the initial
   * engagement-creation DNS resolution (offline, deterministic tests).
   */
  engagement_resolver?: DnsResolver;
  /** 2.1 test injection: replaces the Telegram Bot API client (mock updates). */
  telegram_client?: TelegramClient;
}

export interface NyxServer {
  app: Hono<{ Variables: { actor: Actor } }>;
  start(opts?: { port?: number; host?: string }): Promise<{ port: number; close(): Promise<void> }>;
  close(): Promise<void>;
  /** The auth in effect (owner token etc.) — main.ts prints it when generated. */
  auth: ResolvedAuth;
  /** The approval engine (pending/resolve) — surface-level admin and tests. */
  readonly approvals: ApprovalEngine;
  /** The heartbeat scheduler — registered specs, manual trigger, tests. */
  readonly heartbeats: Scheduler;
  /** The subagent manager — spawn/list/abort, and tests. */
  readonly subagents: SubagentManager;
  /** The durable-task manager — create/get/list/pause/resume/cancel/retry. */
  readonly tasks: TaskManager;
  /** The task worker pool — start/stop, and tests. */
  readonly taskPool: TaskWorkerPool;
}

const HEARTBEAT_MS = 15_000;

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function badRequest(code: string, message: string): Response {
  return Response.json(errorBody(code, message), { status: 400 });
}

const CreateSessionBody = z
  .object({
    persona_id: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
    engagement: EngagementSchema.optional(),
  })
  .strict();

const TurnBody = z
  .object({
    content: z.union([z.array(ContentBlockSchema), z.object({ text: z.string().min(1) }).strict()]),
    /** Accepted for forward compatibility; Phase 0 routes every turn through
     * the default chain (the loop takes no route options). */
    task: z.string().min(1).optional(),
  })
  .strict();

const ForkBody = z.object({ at_seq: z.number().int().positive() }).strict();
const ResolveBody = z.object({ decision: z.enum(["allow", "deny"]) }).strict();

export function createServer(deps: ServerDeps): NyxServer {
  const { config } = deps;

  // ── wiring (order matters: unified db → sink → engine callbacks → kernel services) ──
  mkdirSync(deps.data_dir, { recursive: true });
  const logger = createLogger(config.logging);
  // 2.0.1: ONE SQLite file. The unified opener migrates any Phase 0/1 split
  // layout (policy.db / channels.db / heartbeat.db) in a single verified
  // transaction before anything else runs, then hands the shared handle to
  // every store below. synchronous=FULL, WAL, busy_timeout 5000.
  const unified = openUnifiedDatabase(join(deps.data_dir, "nyx.db"), { logger });
  // Late-bound in-transaction audit hook: the store invokes it INSIDE the
  // append transaction (event + audit commit atomically); the holder is
  // mutated in place once the approval engine exists.
  const auditHook: {
    onEventsCommitted?: (stored: StoredEvent[]) => void;
  } = {};
  const store = openSessionStore(join(deps.data_dir, "nyx.db"), {
    db: unified.db,
    onEventsCommitted: (stored) => auditHook.onEventsCommitted?.(stored),
    // Phase 4 §3: the retention archive rides the same connection — reads
    // of archived sessions (archived = 1) fall back to it transparently.
    archivePath: archivePathOf(join(deps.data_dir, "nyx.db")),
  });
  const sink = createEventSink(store);

  let wsHub: WebSocketHub | undefined;

  const approvalEngineHandle = openApprovalEngine(unified.db, {
    onCreated: (rec) => {
      void sink
        .append(rec.session_id, [
          {
            type: "approval.requested",
            session_id: rec.session_id,
            turn_id: rec.turn_id,
            approval_id: rec.id,
            action_digest: rec.action_digest,
            summary: rec.summary,
            risk: rec.risk,
            ts: Date.now(),
          },
        ])
        .catch((err) =>
          logger.warn("approval.event_append_failed", { error: toSerializedError(err) }),
        );
      wsHub?.broadcastApprovals(rec.session_id, [rec]);
    },
    onResolved: (rec) => {
      void sink
        .append(rec.session_id, [
          {
            type: "approval.resolved",
            session_id: rec.session_id,
            turn_id: rec.turn_id,
            approval_id: rec.id,
            decision: rec.decision === "pending" ? "deny" : rec.decision,
            decided_by: rec.decided_by ?? "system",
            ts: Date.now(),
          },
        ])
        .catch((err) =>
          logger.warn("approval.event_append_failed", { error: toSerializedError(err) }),
        );
    },
  });
  const approvals = approvalEngineHandle.engine;
  // Tool events audit into the same hash chain as approval decisions — since
  // 2.0.1 in the SAME transaction as the event append (see onEventsCommitted
  // above); a crash between the two writes is structurally impossible now.
  auditHook.onEventsCommitted = (stored) => {
    for (const storedEvent of stored) approvalEngineHandle.auditEvent(storedEvent, storedEvent.seq);
  };

  const providers = deps.providers ?? buildProviders(config, logger);
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

  // ── subagents (Phase 3 §2) ──
  // One manager per process. The spawn_subagent tool routes to it through
  // the per-turn RunContext binding (bindTurn/unbindTurn bracket every turn
  // below); children inherit policy/approvals/persona/sandbox and get a
  // FILTERED tool registry + isolated memory view. A parent session's
  // presenter is copied onto its children so an "ask" inside a child turn
  // still reaches the originating channel instead of dying on the TTL.
  const subagentsConfig = resolveSubagentsConfig(config.subagents);
  // Late-bound: the tasks manager (created below, after the sandbox/persona
  // wiring) installs the reporter so a spawn's child session lands on the
  // task row the moment it exists — pause/cancel from another process can
  // then target the RUNNING child, not just the last settled one.
  const taskSpawnReport: { report?: (child: string, parent: string) => void } = {};
  const subagents = createSubagentManager({
    store: sink.wrapped,
    config: subagentsConfig,
    db: unified.db,
    onSpawned: ({ session_id, parent_session_id }) => {
      taskSpawnReport.report?.(session_id, parent_session_id);
      const inherited = approvalEngineHandle.engine.presenterFor(parent_session_id);
      if (inherited !== undefined) {
        approvalEngineHandle.engine.registerPresenter(session_id, inherited.presenter, {
          ttl_ms: inherited.ttl_ms,
        });
      }
    },
    onSettled: (session_id) => {
      if (approvalEngineHandle.engine.presenterFor(session_id) !== undefined) {
        approvalEngineHandle.engine.unregisterPresenter(session_id);
      }
    },
  });
  registerSubagentTool(toolRegistry, { manager: subagents, config: subagentsConfig });
  // Phase 4 §4: in fork mode the parent also gets the artifact-handoff read
  // tool (absent in inherit mode — there is no child sandbox to read from).
  if (subagentsConfig.sandbox_sharing === "fork") {
    registerSubagentArtifactTools(toolRegistry, { manager: subagents });
  }
  // 2.2: the four-tier compaction pipeline, configured from
  // context.compaction; the loop looks it up as a kernel service.
  kernel.services.set(
    COMPACTION_SERVICE,
    createCompactionPipeline({
      ...config.context?.compaction,
    }),
  );

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

  const auth = resolveAuth(config.server, process.env);
  const loop = createAgentLoop();

  // ── durable tasks (Phase 4 §2.1) ──
  // One manager + one worker pool per process. Attempts execute as
  // subagents of the TASK's own session (its metadata log); the spawn's
  // parent signal is the attempt's abort signal, so pause/cancel/shutdown
  // propagate through the existing Phase 3 abort machinery. Workers
  // coordinate with any other NYX process on the same nyx.db through SQL
  // leases — no other coordination exists or is needed.
  const tasks: TaskManager = createTaskManager({
    db: unified.db,
    store: sink.wrapped,
  });
  const taskContextFor = async (
    task: TaskRecord,
    signal: AbortSignal,
  ): Promise<RunContext> => {
    const meta = await store.meta(task.task_session_id);
    const log = logger.child({
      session_id: task.task_session_id,
      task_id: task.id,
      component: "task",
    });
    return {
      kernel,
      session: sink.wrapped,
      model: router,
      tools: toolRegistry,
      tool_router: toolRouter,
      policy,
      approvals,
      sandbox: await sandboxFor(task.task_session_id),
      memory,
      persona: await personaFor(meta?.persona_id ?? config.persona.default_id),
      signal,
      logger: log,
    };
  };
  const taskRunner: TaskRunner = {
    run: async (task, handle) => {
      // System tasks never spawn a subagent (§3): the retention pass is pure
      // SQL + audit on the shared handle, and its result is synthesized —
      // no model spend, no child session, nothing to budget.
      if (isSystemTaskId(task.id)) {
        const started_at = Date.now();
        return runRetentionAttempt(
          {
            db: unified.db,
            archivePath: archivePathOf(join(deps.data_dir, "nyx.db")),
            config: {
              retention_days: subagentsConfig.retention_days,
              retention_scope: subagentsConfig.retention_scope,
              delete_after_days: subagentsConfig.delete_after_days,
            },
          },
          task.task_session_id,
          started_at,
        );
      }
      const turn_id = `task-${task.id}-${task.attempts + 1}`;
      const ctx = await taskContextFor(task, handle.signal);
      // subagents.bindTurn is unnecessary here: the spawn_subagent tool is
      // not reachable from the runner path (this is not a model turn).
      const result = await subagents.spawn(
        { ...task.spec.subagent_spec, task: task.spec.description },
        ctx,
        { session_id: task.task_session_id, turn_id },
      );
      // Mid-flight reporting came through onSpawned (taskSpawnReport); this
      // is the settle-time confirmation for the record.
      handle.setSubagentSession(result.session_id);
      return result;
    },
    abort: async (task) => {
      if (isSystemTaskId(task.id)) return; // synchronous pass — nothing to abort
      const row = await tasks.get(task.id);
      if (row?.subagent_session_id != null) {
        await subagents.abort(row.subagent_session_id);
      }
    },
  };
  taskSpawnReport.report = (child, parent) => {
    tasks.sql.noteSubagentSessionByTaskSession(parent, child);
  };
  const taskPool = new TaskWorkerPool({
    manager: tasks,
    runner: taskRunner,
    store: sink.wrapped,
    logger,
    config: {
      workers: config.tasks?.workers ?? 2,
      poll_ms: config.tasks?.poll_interval_ms ?? 500,
      lease_ttl_ms: config.tasks?.lease_ttl_ms ?? 300_000,
      renew_interval_ms: config.tasks?.renew_interval_ms ?? 30_000,
    },
  });

  // ── per-session turn execution (lane queue) ──
  // One session = one lane = serial execution; turns POSTed while one is in
  // flight queue up (FIFO) instead of 409ing. The global cap and round-robin
  // scheduling keep a burst of sessions from starving each other. Aborting a
  // running turn (close()) cancels it and drains that session's queue.
  const lanes: LaneQueue = createLaneQueue({
    max_concurrent_global: config.lanes?.max_concurrent_global ?? 4,
    max_concurrent_per_session: config.lanes?.max_concurrent_per_session ?? 1,
    heartbeat_serialized_with_interactive:
      config.lanes?.heartbeat_serialized_with_interactive ?? true,
  });
  const turnControllers = new Map<string, AbortController>();

  const runTurn = async (
    session_id: string,
    turn_id: string,
    content: ContentBlock[],
    controller: AbortController,
    onEvent?: (event: SessionEvent) => void,
  ): Promise<void> => {
    turnControllers.set(session_id, controller);
    const log = logger.child({ session_id, turn_id, component: "turn" });
    try {
      const meta = await store.meta(session_id);
      if (meta === null) {
        log.error("turn.session_missing");
        return;
      }
      const ctx: RunContext = {
        kernel,
        session: sink.wrapped,
        model: router,
        tools: toolRegistry,
        tool_router: toolRouter,
        policy,
        approvals,
        sandbox: await sandboxFor(session_id),
        memory,
        persona: await personaFor(meta.persona_id),
        signal: controller.signal,
        logger: log,
      };
      // The spawn_subagent tool resolves its parent through this binding.
      subagents.bindTurn(session_id, turn_id, ctx);
      for await (const event of loop.run(
        { session_id, turn_id, user_message: { role: "user", content } },
        ctx,
      )) {
        // The loop appended every event to the store through the sink before
        // yielding it; consuming keeps the generator alive. Channels tap this
        // stream for live rendering (Telegram edits).
        onEvent?.(event);
      }
    } catch (err) {
      // The loop emits turn.failed for in-turn errors; a throw here is a
      // surface defect (missing service, broken persona load) — log it loud.
      log.error("turn.threw", { error: toSerializedError(err) });
    } finally {
      subagents.unbindTurn(session_id);
      turnControllers.delete(session_id);
    }
  };

  // ── channel ingress (Phase 1 §1.2, approvals Phase 2 §2.1) ──
  // Channels drive the SAME machinery the HTTP API does — lane queue, agent
  // loop, policy, approvals — through the runner below; there is no separate
  // policy path for channel traffic. Identity, session mapping, and command
  // handling live in @nyx/channels' manager; approval PRESENTATION lives in
  // the channel presenters registered per turn below.
  const webhookApprovalPresenter = new WebhookApprovalPresenter();
  let telegramBridge: TelegramApprovalBridge | undefined;

  const presenterFor = (channel: { id: string; thread_id?: string } | undefined) => {
    if (channel === undefined) return undefined;
    if (channel.id === "telegram" && telegramBridge !== undefined && channel.thread_id !== undefined) {
      return {
        presenter: telegramBridge.presenterFor(channel.thread_id),
        ttl: config.channels?.telegram?.approval_ttl_ms,
      };
    }
    if (channel.id === "webhook") {
      return {
        presenter: webhookApprovalPresenter,
        ttl: config.channels?.webhook?.approval_ttl_ms,
      };
    }
    return undefined;
  };

  const startChannelTurn = (input: {
    session_id: string;
    owner_id: string;
    content: ContentBlock[];
    channel?: { id: string; thread_id?: string };
  }): ChannelTurnHandle => {
    const turn_id = nanoid(12);
    const controller = new AbortController();
    const handlers = new Set<(event: SessionEvent) => void>();
    const events: SessionEvent[] = [];
    // 2.1: while this turn runs, its session's approvals present on the
    // originating channel (inline keyboard / approval_required body) with
    // the channel TTL (default 5 min).
    const presented = presenterFor(input.channel);
    if (presented !== undefined) {
      approvalEngineHandle.engine.registerPresenter(
        input.session_id,
        presented.presenter,
        presented.ttl !== undefined ? { ttl_ms: presented.ttl } : {},
      );
    }
    const completion = lanes
      .enqueue({
        session_id: input.session_id,
        priority: "interactive",
        signal: controller.signal,
        run: () =>
          runTurn(input.session_id, turn_id, input.content, controller, (event) => {
            events.push(event);
            for (const h of handlers) h(event);
          }),
      })
      .then(
        () => ({ ok: true, text: replyTextFromEvents(events) }),
        () => ({ ok: false, text: "" }),
      )
      .finally(() => {
        // No orphaned presenter: pending approvals are denied + withdrawn.
        if (presented !== undefined) {
          approvalEngineHandle.engine.unregisterPresenter(input.session_id);
        }
      });
    return {
      turn_id,
      completion,
      onEvent: (cb) => {
        handlers.add(cb);
        return () => handlers.delete(cb);
      },
    };
  };

  const channelRunner: ChannelTurnRunner = {
    createSession: async (input) => {
      const persona_id = input.persona_id ?? config.persona.default_id;
      await personaFor(persona_id);
      return store.create({
        owner_id: input.owner_id,
        persona_id,
        ...(input.title !== undefined ? { title: input.title } : {}),
      });
    },
    forkSession: async (session_id) => {
      const projection = await store.projection(session_id);
      return store.fork(session_id, projection.last_seq);
    },
    startTurn: startChannelTurn,
  };

  const channelManager = new ChannelManager({
    config: {
      ...(config.channels?.webhook !== undefined ? { webhook: config.channels.webhook } : {}),
      ...(config.channels?.telegram !== undefined ? { telegram: config.channels.telegram } : {}),
    },
    runner: channelRunner,
    sessions: new ChannelSessionStore(unified.db),
    audit: (entry) => approvalEngineHandle.audit(entry),
    logger,
  });
  const channelAdapters: ChannelAdapter[] = [];

  // ── heartbeat / cron (Phase 1 §1.3) ──
  // Scheduled system turns, enqueued at heartbeat priority into the session
  // lane (the same serialization point as API turns and channel turns).
  // State persists in the unified nyx.db (heartbeat tables); missed fires are
  // logged, never re-fired. Disabled unless the operator opts in via
  // config.heartbeat.
  const heartbeatStore = new HeartbeatStore(unified.db, { ownsDb: false });
  const heartbeatScheduler = createHeartbeatScheduler({
    store: heartbeatStore,
    specs: config.heartbeat?.specs ?? [],
    logger,
    pollIntervalMs: 30_000,
    sink: {
      fire: async (spec, scheduledFor) => {
        let session_id = spec.session_id ?? null;
        if (session_id === null) {
          // New session per fire (§5.1 default).
          const persona_id = spec.persona_id ?? config.persona.default_id;
          await personaFor(persona_id);
          const meta = await store.create({
            owner_id: config.owner_id,
            persona_id,
            title: `heartbeat ${spec.id}`,
          });
          session_id = meta.session_id;
        }
        const turn_id = `hb-${spec.id}-${scheduledFor}`;
        await lanes.enqueue({
          session_id,
          priority: "heartbeat",
          run: () =>
            runTurn(session_id!, turn_id, [{ type: "text", text: spec.prompt }], new AbortController()),
        });
      },
    },
  });
  const startChannels = async (): Promise<void> => {
    if (config.channels?.webhook?.enabled === true) {
      const adapter = new WebhookChannel({
        config: config.channels.webhook,
        manager: channelManager,
        logger,
        approvalPresenter: webhookApprovalPresenter,
      });
      channelAdapters.push(adapter);
      await adapter.start();
    }
    if (config.channels?.telegram?.enabled === true) {
      const token = process.env[config.channels.telegram.bot_token_env] ?? "";
      const client =
        deps.telegram_client ??
        (token !== ""
          ? createHttpTelegramClient(token)
          : undefined);
      if (client === undefined) {
        throw new Error(
          `channels.telegram is enabled but ${config.channels.telegram.bot_token_env} is not set`,
        );
      }
      // 2.1: callback queries (approval buttons) route through the bridge;
      // identity is gated by allowed_user_ids, resolution goes through the
      // engine — the adapter never decides.
      telegramBridge = new TelegramApprovalBridge({
        client,
        allowedUserIds: config.channels.telegram.allowed_user_ids,
        resolve: (approvalId, decision, actor) =>
          approvalEngineHandle.engine.resolve(approvalId, decision, actor),
        logger,
      });
      const adapter = new TelegramChannel({
        config: config.channels.telegram,
        manager: channelManager,
        client,
        logger,
        onCallbackQuery: (query) => {
          void telegramBridge!.handleCallbackQuery(query);
        },
      });
      channelAdapters.push(adapter);
      await adapter.start();
    }
  };

  // ── HTTP app ──
  const app = new Hono<{ Variables: { actor: Actor } }>();
  app.use(
    "/v1/*",
    cors({
      origin: (origin) =>
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null,
    }),
  );

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/health") return next();
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const actor = authenticate(token, auth);
    if (actor === null) {
      return c.json(errorBody("validation_failed", "missing or invalid bearer token"), 401);
    }
    c.set("actor", actor);
    return next();
  });

  app.onError((err, c) => {
    logger.error("http.unhandled", { error: toSerializedError(err), path: c.req.path });
    return c.json(errorBody("provider_error", "internal error"), 500);
  });

  app.get("/v1/health", async (c) => {
    const sandboxHealthy = config.sandbox.provider === "docker" ? await checkDocker() : true;
    const providerList = providerRegistry.list().map((p) => ({ id: p.id, models: 0 }));
    for (const entry of providerList) {
      try {
        const models = await providerRegistry.get(entry.id)?.listModels();
        entry.models = models?.length ?? 0;
      } catch {
        entry.models = 0;
      }
    }
    return c.json({
      status: "ok",
      version: SERVER_ID,
      brand: BRAND.name,
      node: process.version,
      sandbox: { provider: config.sandbox.provider, healthy: sandboxHealthy },
      providers: providerList,
    });
  });

  app.post("/v1/sessions", async (c) => {
    const parsed = CreateSessionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return badRequest(
        "validation_failed",
        parsed.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; "),
      );
    }
    const body = parsed.data;
    if (body.engagement !== undefined) {
      const problems = validateTargets(body.engagement.targets);
      if (problems.length > 0) {
        return badRequest(
          "validation_failed",
          `invalid engagement targets: ${problems.join("; ")}`,
        );
      }
      // An engagement authorizes its own operator's sessions — nothing else.
      try {
        assertEngagementOwnership(body.engagement, config.owner_id);
      } catch (err) {
        if (err instanceof EngagementOwnershipError) {
          return badRequest(err.code, err.message);
        }
        throw err;
      }
    }
    const persona_id = body.persona_id ?? config.persona.default_id;
    try {
      await personaFor(persona_id);
    } catch (err) {
      return badRequest(
        "validation_failed",
        `unknown persona "${persona_id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const meta = await store.create({
      owner_id: config.owner_id,
      persona_id,
      ...(body.title !== undefined ? { title: body.title } : {}),
      engagement: body.engagement ?? null,
    });
    // 2.0.4: every engagement binding lands on the audit chain. Domain-only
    // engagements record the initial DNS resolution (post-hoc validation of
    // what the runtime pin will trust); CIDR-constrained ones record the
    // constraint. Informational only — no runtime behavior change.
    if (body.engagement !== undefined && body.engagement !== null) {
      await auditEngagementCreated(
        {
          audit: (entry) => approvalEngineHandle.audit(entry),
          logger,
          ...(deps.engagement_resolver !== undefined
            ? { resolve: deps.engagement_resolver }
            : {}),
        },
        { session_id: meta.session_id, engagement: body.engagement, owner_id: config.owner_id },
      );
    }
    return c.json(meta, 201);
  });

  app.get("/v1/sessions", async (c) => {
    const limit = Number(c.req.query("limit") ?? "100");
    const owner_id = c.req.query("owner_id");
    // Phase 3 §2.8: subagent sessions are hidden unless explicitly asked
    // for (they clutter the list and are reachable via their parent).
    const includeSubagents = c.req.query("include_subagents") === "true";
    const sessions = await store.list({
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      ...(owner_id !== undefined && owner_id.length > 0 ? { owner_id } : {}),
      ...(includeSubagents ? {} : { kinds: ["session", "fork"] }),
    });
    return c.json(sessions);
  });

  app.get("/v1/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const meta = await store.meta(id);
    if (meta === null) return c.json(errorBody("not_found", `session ${id} not found`), 404);
    return c.json({ session: meta, projection: await store.projection(id) });
  });

  app.get("/v1/sessions/:id/events", async (c) => {
    const id = c.req.param("id");
    const meta = await store.meta(id);
    if (meta === null) return c.json(errorBody("not_found", `session ${id} not found`), 404);
    const fromQuery = Number(c.req.query("from_seq") ?? "");
    let fromSeq: number;
    if (Number.isInteger(fromQuery) && fromQuery >= 0) {
      fromSeq = fromQuery;
    } else {
      const last = c.req.header("Last-Event-ID");
      fromSeq = last !== undefined && /^\d+$/.test(last) ? Number(last) : 0;
    }
    // from_seq / Last-Event-ID mean "the last seq the client already has":
    // the store stream replays inclusively from its argument, so resume
    // strictly AFTER it (no duplicate resend on reconnect).
    return streamSSE(c, async (stream) => {
      for await (const item of withHeartbeat(store.stream(id, fromSeq + 1), HEARTBEAT_MS)) {
        if (item === "beat") {
          await stream.write(": ping\n\n");
        } else {
          await stream.writeSSE({
            id: String(item.seq),
            event: "nyx",
            data: JSON.stringify(item),
          });
        }
      }
    });
  });

  app.post("/v1/sessions/:id/turns", async (c) => {
    const id = c.req.param("id");
    const meta = await store.meta(id);
    if (meta === null) return c.json(errorBody("not_found", `session ${id} not found`), 404);
    const parsed = TurnBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return badRequest(
        "validation_failed",
        parsed.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; "),
      );
    }
    const content = (
      Array.isArray(parsed.data.content)
        ? parsed.data.content
        : [{ type: "text", text: parsed.data.content.text }]
    ) as ContentBlock[];
    const turn_id = nanoid(12);
    // Enqueue into the session's lane: the turn runs when the lane reaches
    // it (serial per session), the route returns immediately, and the event
    // stream (SSE/WS) carries events from the queue position onward.
    const controller = new AbortController();
    void lanes
      .enqueue({
        session_id: id,
        priority: "interactive",
        run: () => runTurn(id, turn_id, content, controller),
        signal: controller.signal,
      })
      .catch(() => undefined); // lane aborts (close/drain) are expected
    const status = lanes.status(id);
    return c.json({ turn_id, session_id: id, lane: status }, 202);
  });

  // 2.0.2: per-session abort. Aborts the RUNNING turn, clears that session's
  // queued turns (other sessions untouched), and withdraws any pending
  // approvals so the aborted turn cannot linger on a blocking request().
  // Auth: same as turn creation (an authenticated actor; sessions are
  // owner-scoped). The aborted turn's events end with turn.failed
  // reason "aborted".
  app.delete("/v1/sessions/:id/turns", async (c) => {
    const id = c.req.param("id");
    const meta = await store.meta(id);
    if (meta === null) return c.json(errorBody("not_found", `session ${id} not found`), 404);
    const status = lanes.status(id);
    const abortedRunning = status.running || turnControllers.has(id);
    const clearedQueued = status.depth;
    turnControllers.get(id)?.abort(); // cancels the running turn (if any)
    approvalEngineHandle.engine.withdrawSession(id, "turn aborted");
    lanes.clear(id); // rejects every queued turn of THIS session only
    return c.json({ aborted_running: abortedRunning, cleared_queued: clearedQueued });
  });

  // ── Phase 3 §3.1: subagent routes ──

  // Children of one session (restart-safe: reconstructed from the event log).
  app.get("/v1/sessions/:id/subagents", async (c) => {
    const id = c.req.param("id");
    const meta = await store.meta(id);
    if (meta === null) return c.json(errorBody("not_found", `session ${id} not found`), 404);
    return c.json(await subagents.list(id));
  });

  // Abort a running subagent (owner-only). In-process children abort
  // directly; anything running elsewhere gets a control-row request in
  // nyx.db that the owning process's manager drains (same pattern as the
  // approval engine's poll).
  app.delete("/v1/subagents/:id", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    const meta = await store.meta(id);
    if (meta === null) return c.json(errorBody("not_found", `subagent ${id} not found`), 404);
    if (meta.kind !== "subagent") {
      return badRequest("validation_failed", `session ${id} is not a subagent session`);
    }
    if (!actor.is_owner && actor.id !== meta.owner_id) {
      return c.json(errorBody("forbidden", "only the owner may abort a subagent"), 403);
    }
    await subagents.abort(id);
    return c.json({ aborted: id });
  });

  // Archive a subagent session (§2.8): aborts if running, marks archived —
  // nothing is hard-deleted; the id stays resolvable and the log replayable.
  app.delete("/v1/sessions/:id", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    const meta = await store.meta(id);
    if (meta === null) return c.json(errorBody("not_found", `session ${id} not found`), 404);
    if (meta.kind !== "subagent") {
      return badRequest(
        "validation_failed",
        `only subagent sessions can be archived (session ${id} is kind "${meta.kind}")`,
      );
    }
    if (!actor.is_owner && actor.id !== meta.owner_id) {
      return c.json(errorBody("forbidden", "only the owner may archive a subagent session"), 403);
    }
    await subagents.abort(id);
    const archived = await store.archiveSession(id);
    return c.json({ archived: true, session: archived });
  });

  app.post("/v1/sessions/:id/fork", async (c) => {
    const id = c.req.param("id");
    const meta = await store.meta(id);
    if (meta === null) return c.json(errorBody("not_found", `session ${id} not found`), 404);
    const parsed = ForkBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return badRequest("validation_failed", "body must be {at_seq: positive integer}");
    }
    try {
      const child = await store.fork(id, parsed.data.at_seq);
      return c.json(child, 201);
    } catch (err) {
      return badRequest("validation_failed", err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/v1/approvals", async (c) => {
    const session_id = c.req.query("session_id");
    if (session_id === undefined || session_id.length === 0) {
      return badRequest("validation_failed", "session_id query parameter is required");
    }
    return c.json(await approvals.pending(session_id));
  });

  const resolveApprovalHandler = async (c: Context) => {
    const actor = c.get("actor");
    const id = c.req.param("id") ?? "";
    const parsed = ResolveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return badRequest("validation_failed", 'body must be {decision: "allow" | "deny"}');
    }
    const rec = await approvals.get(id);
    if (rec === null) return c.json(errorBody("not_found", `approval ${id} not found`), 404);
    if (rec.risk === "R4" && !actor.is_owner) {
      return c.json(
        errorBody("approval_denied", "R4 approvals may only be resolved by the owner"),
        403,
      );
    }
    try {
      const resolved = await approvals.resolve(id, parsed.data.decision, actor.id);
      return c.json(resolved);
    } catch (err) {
      const code =
        err instanceof Error && "code" in err
          ? String((err as { code: unknown }).code)
          : "approval_denied";
      return c.json(errorBody(code, err instanceof Error ? err.message : String(err)), 409);
    }
  };

  app.post("/v1/approvals/:id", resolveApprovalHandler);
  // 2.1.3: the canonical channel-facing path (the resolve_url handed out in
  // approval_required bodies). Same handler, same auth, same R4 gate.
  app.post("/v1/approvals/:id/resolve", resolveApprovalHandler);

  app.get("/v1/models", async (c) => {
    return c.json(await router.listModels());
  });

  // ── Phase 4 §2.1.6: durable task routes ──

  // Create: the spec (Zod-validated, defaults filled) + the calling actor as
  // owner. A bound task's owner is forced to the parent session's owner (the
  // manager enforces cross-owner refusal — hard rule #6).
  app.post("/v1/tasks", async (c) => {
    const actor = c.get("actor");
    const parsed = TaskSpecSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return badRequest(
        "validation_failed",
        parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
          .join("; "),
      );
    }
    try {
      const record = await tasks.create(
        parsed.data,
        {
          owner_id: actor.is_owner ? config.owner_id : actor.id,
          persona_id: config.persona.default_id,
        },
      );
      return c.json(record, 201);
    } catch (err) {
      const code =
        err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "validation_failed";
      const status = code === "not_found" ? 404 : code === "illegal_transition" ? 409 : 400;
      return c.json(errorBody(code, err instanceof Error ? err.message : String(err)), status);
    }
  });

  app.get("/v1/tasks", async (c) => {
    const stateParam = c.req.query("state");
    let state: TaskState[] | undefined;
    if (stateParam !== undefined && stateParam.length > 0) {
      const raw = stateParam.split(",").map((s) => s.trim()) as TaskState[];
      const valid = ["pending", "running", "paused", "completed", "failed", "cancelled"];
      if (raw.some((s) => !valid.includes(s))) {
        return badRequest("validation_failed", `unknown task state in "${stateParam}"`);
      }
      state = raw;
    }
    const parent = c.req.query("parent_session_id");
    const limit = Number(c.req.query("limit") ?? "100");
    return c.json(
      await tasks.list({
        ...(state !== undefined ? { state } : {}),
        ...(parent !== undefined && parent.length > 0 ? { parent_session_id: parent } : {}),
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      }),
    );
  });

  app.get("/v1/tasks/:id", async (c) => {
    const record = await tasks.get(c.req.param("id"));
    if (record === null) return c.json(errorBody("not_found", "task not found"), 404);
    return c.json(record);
  });

  const taskAction = (action: "pause" | "resume" | "retry") => async (c: Context): Promise<Response> => {
    const id = c.req.param("id") ?? "";
    try {
      await tasks[action](id);
      const record = await tasks.get(id);
      if (record === null) return c.json(errorBody("not_found", "task not found"), 404);
      return c.json(record);
    } catch (err) {
      const code =
        err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "illegal_transition";
      const status = code === "not_found" ? 404 : 409;
      return c.json(errorBody(code, err instanceof Error ? err.message : String(err)), status);
    }
  };
  app.post("/v1/tasks/:id/pause", taskAction("pause"));
  app.post("/v1/tasks/:id/resume", taskAction("resume"));
  app.post("/v1/tasks/:id/retry", taskAction("retry"));

  // Cancel (DELETE): hard stop — a running attempt is aborted; the row goes
  // to cancelled (legal from any state).
  app.delete("/v1/tasks/:id", async (c) => {
    const id = c.req.param("id");
    const before = await tasks.get(id);
    if (before === null) return c.json(errorBody("not_found", "task not found"), 404);
    try {
      await tasks.cancel(id);
    } catch (err) {
      const code =
        err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "illegal_transition";
      return c.json(errorBody(code, err instanceof Error ? err.message : String(err)), 409);
    }
    // Cross-process abort insurance: if this process isn't running the
    // attempt, the owning process's subagent manager drains the request.
    const after = await tasks.get(id);
    if (after?.subagent_session_id != null && !taskPool.runningIds.has(id)) {
      await subagents.abort(after.subagent_session_id).catch(() => undefined);
    }
    return c.json({ cancelled: id });
  });

  // ── lifecycle ──
  let httpServer: HttpServer | undefined;
  let closing = false;

  return {
    app,
    auth,
    get approvals() {
      return approvals;
    },
    get heartbeats() {
      return heartbeatScheduler;
    },
    get subagents() {
      return subagents;
    },
    get tasks() {
      return tasks;
    },
    get taskPool() {
      return taskPool;
    },
    async start(opts = {}) {
      const port = opts.port ?? config.server?.port ?? 8787;
      const host = opts.host ?? config.server?.host ?? "127.0.0.1";
      const server = serve({ fetch: app.fetch, port, hostname: host }, () => {
        logger.info("server.started", { host, port, brand: BRAND.name, version: SERVER_ID });
      });
      // serve() returns before the socket is bound; wait for listening so
      // server.address() reports the real (possibly ephemeral) port.
      await new Promise<void>((resolve) => {
        if (server.listening) return resolve();
        server.once("listening", () => resolve());
      });
      httpServer = server as HttpServer;
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      wsHub = injectWebSocketServer(server as HttpServer, {
        auth,
        store,
        pendingApprovals: (session_id) => approvals.pending(session_id),
        logger,
      });
      await startChannels();
      if (config.heartbeat?.enabled === true) {
        await heartbeatScheduler.start();
        logger.info("heartbeat.started", {
          specs: heartbeatScheduler.list().filter((s) => s.enabled).map((s) => s.id),
        });
      }
      // Phase 4 §2.1.6: the worker pool starts with the process. Graceful
      // shutdown (close below) aborts running attempts and releases their
      // leases so another NYX process on the same nyx.db reclaims them.
      if (config.tasks?.enabled !== false) {
        // Phase 4 §3: retention is a SCHEDULED DURABLE TASK, not a startup
        // sweep — the surface only ensures the `nyx:retention-gc` task
        // EXISTS (opt-in via subagents.retention_enabled); the worker pool
        // fires it on its cron. Idempotent: absent → created, terminally
        // dead → revived, healthy/paused → untouched.
        if (
          subagentsConfig.retention_enabled &&
          subagentsConfig.retention_days > 0 &&
          subagentsConfig.retention_scope !== "none"
        ) {
          await ensureRetentionTask(
            tasks,
            { retention_schedule: subagentsConfig.retention_schedule },
            { owner_id: config.owner_id, persona_id: config.persona.default_id },
          );
          logger.info("tasks.retention_scheduled", {
            task: "nyx:retention-gc",
            schedule: subagentsConfig.retention_schedule,
            scope: subagentsConfig.retention_scope,
            retention_days: subagentsConfig.retention_days,
            delete_after_days: subagentsConfig.delete_after_days,
          });
        }
        taskPool.start();
        logger.info("tasks.workers_started", {
          workers: config.tasks?.workers ?? 2,
        });
      }
      return {
        port: actualPort,
        close: () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      };
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const adapter of channelAdapters.splice(0)) {
        await adapter.stop().catch((err: unknown) => {
          logger.warn("channel.stop_failed", { error: toSerializedError(err), channel: adapter.id });
        });
      }
      await heartbeatScheduler.stop();
      heartbeatStore.close();
      // Phase 4: abort running task attempts and RELEASE their leases
      // (owner kept, expiry moved into the past) before anything else winds
      // down — another process may reclaim mid-shutdown.
      await taskPool.stop();
      for (const controller of turnControllers.values()) controller.abort();
      turnControllers.clear();
      // 2.1: session close with a pending approval — withdraw + auto-deny,
      // no orphans (presenters learn their requests died).
      for (const session_id of approvalEngineHandle.engine.presenterSessions()) {
        approvalEngineHandle.engine.unregisterPresenter(session_id);
      }
      await wsHub?.close();
      await new Promise<void>((resolve) => {
        if (httpServer === undefined) return resolve();
        httpServer.close(() => resolve());
      });
      for (const sandbox of sessionSandboxes.values()) {
        await sandbox.destroy().catch(() => undefined);
      }
      sessionSandboxes.clear();
      store.close();
      approvalEngineHandle.close(); // no-op on the shared handle
      unified.close(); // the one owner of the nyx.db handle
    },
  };
}

/** Races the source against a heartbeat timer; every `HEARTBEAT_MS` without
 * an event yields "beat" so the SSE connection shows liveness. The timer
 * resets on every event. */
async function* withHeartbeat<T>(
  source: AsyncIterable<T>,
  ms: number,
): AsyncGenerator<T | "beat", void, unknown> {
  const iterator = source[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<T>> = iterator.next();
  pending.catch(() => undefined);
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const beat = new Promise<"beat">((resolve) => {
        timer = setTimeout(() => resolve("beat"), ms);
      });
      const winner = await Promise.race([
        pending.then((result) => ({ kind: "next" as const, result })),
        beat.then(() => ({ kind: "beat" as const })),
      ]);
      if (winner.kind === "beat") {
        yield "beat";
        continue;
      }
      if (winner.result.done) return;
      pending = iterator.next();
      pending.catch(() => undefined);
      yield winner.result.value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
