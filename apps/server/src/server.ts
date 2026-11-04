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

import { Hono } from "hono";
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
import { openSessionStore } from "@nyx/session";
import { openApprovalEngine, PolicyEngineImpl } from "@nyx/policy";
import { EngagementOwnershipError, assertEngagementOwnership } from "@nyx/policy";
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
import { createLaneQueue, createHeartbeatScheduler, HeartbeatStore } from "@nyx/runtime";
import type { LaneQueue, Scheduler } from "@nyx/runtime";
import {
  ChannelManager,
  ChannelSessionStore,
  TelegramChannel,
  WebhookChannel,
  createHttpTelegramClient,
  replyTextFromEvents,
} from "@nyx/channels";
import type {
  ChannelAdapter,
  ChannelTurnHandle,
  ChannelTurnRunner,
} from "@nyx/channels";
import {
  ContentBlockSchema,
  EngagementSchema,
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
  /** Root for nyx.db / policy.db (created if missing). */
  data_dir: string;
  /** Test injection: replaces config-derived providers, registered by id. */
  providers?: ModelProvider[];
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
      turnControllers.delete(session_id);
    }
  };

  // ── channel ingress (Phase 1 §1.2) ──
  // Channels drive the SAME machinery the HTTP API does — lane queue, agent
  // loop, policy, approvals — through the runner below; there is no separate
  // policy path for channel traffic. Identity, session mapping, and command
  // handling live in @nyx/channels' manager.
  const startChannelTurn = (input: {
    session_id: string;
    owner_id: string;
    content: ContentBlock[];
  }): ChannelTurnHandle => {
    const turn_id = nanoid(12);
    const controller = new AbortController();
    const handlers = new Set<(event: SessionEvent) => void>();
    const events: SessionEvent[] = [];
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
      );
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
      });
      channelAdapters.push(adapter);
      await adapter.start();
    }
    if (config.channels?.telegram?.enabled === true) {
      const token = process.env[config.channels.telegram.bot_token_env] ?? "";
      if (token === "") {
        throw new Error(
          `channels.telegram is enabled but ${config.channels.telegram.bot_token_env} is not set`,
        );
      }
      const adapter = new TelegramChannel({
        config: config.channels.telegram,
        manager: channelManager,
        client: createHttpTelegramClient(token),
        logger,
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
    return c.json(meta, 201);
  });

  app.get("/v1/sessions", async (c) => {
    const limit = Number(c.req.query("limit") ?? "100");
    const owner_id = c.req.query("owner_id");
    const sessions = await store.list({
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      ...(owner_id !== undefined && owner_id.length > 0 ? { owner_id } : {}),
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

  app.post("/v1/approvals/:id", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
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
  });

  app.get("/v1/models", async (c) => {
    return c.json(await router.listModels());
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
      for (const controller of turnControllers.values()) controller.abort();
      turnControllers.clear();
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
