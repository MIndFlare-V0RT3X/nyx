// SPDX-License-Identifier: AGPL-3.0-or-later
// The SubagentManager (Phase 3 §2.1–§2.5). One instance per process, wired by
// the surface (server / CLI local runtime) and reached from the model through
// the spawn_subagent tool (via the per-turn RunContext binding).
//
// Lifecycle (§2.4): depth check → per-turn budget check → child session
// (kind="subagent", parent_id, persona + engagement inherited) → mirrored
// subagent.spawned events on both logs → child RunContext (filtered tool
// registry + filtered tool runtime + isolated memory view + budget-guarded
// model router + shared sandbox) → AgentLoop.run with the task as the initial
// user message → summary/tokens/duration harvested from the child's own
// events → mirrored terminal event → SubagentResult back to the parent's
// tool.result. Child events NEVER enter the parent's log — only the summary
// crosses the boundary.
//
// Abort paths: the parent's signal (hard rule #5), the per-subagent budget
// (hard rule #4), or an external abort — in-process (DELETE
// /v1/subagents/:id) or cross-process (`nyx subagents abort`, via the
// subagent_abort_requests table this manager polls).

import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import type {
  AgentLoop,
  ContentBlock,
  RunContext,
  SerializedError,
  SessionEvent,
  SessionStore,
  StoredEvent,
  SubagentInfo,
  SubagentResult,
  SubagentSpec,
  Usage,
} from "@nyx/protocol";
import { createAgentLoop } from "@nyx/agent";
import {
  BudgetTrackingRouter,
  buildChildTooling,
  childMemory,
  childUserMessage,
} from "./child-views.js";
import { resolveSubagentsConfig, type SubagentsConfig } from "./config.js";
import { requestSubagentAbort, takeSubagentAbortRequests } from "./control.js";
import { SubagentError } from "./errors.js";

/** The per-turn binding the spawn_subagent tool resolves its parent through. */
export interface BoundTurn {
  turn_id: string;
  ctx: RunContext;
}

/** Identifies the parent turn a spawn hangs off (RunContext carries no ids). */
export interface SubagentParentRef {
  session_id: string;
  turn_id: string;
}

export interface SubagentManager {
  spawn(
    spec: SubagentSpec,
    parent_ctx: RunContext,
    parent: SubagentParentRef,
  ): Promise<SubagentResult>;
  list(parent_session_id: string): Promise<SubagentInfo[]>;
  abort(subagent_session_id: string): Promise<void>;
  /** Remaining spawn depth from this session (max_depth minus its subagent lineage). */
  depth_for(session_id: string): Promise<number>;
  /** Surface wiring: the active turn's RunContext (the tool path's parent). */
  bindTurn(session_id: string, turn_id: string, ctx: RunContext): void;
  unbindTurn(session_id: string): void;
  /** The bound RunContext for a session+turn — the spawn_subagent tool's parent. */
  boundTurn(session_id: string, turn_id: string): BoundTurn | undefined;
}

export interface SubagentManagerDeps {
  /** The session store (or sink-wrapped view) — list/depth/abort queries. */
  store: SessionStore;
  /** The subagents config section; defaults fill anything absent. */
  config?: Partial<SubagentsConfig>;
  /** Loop factory override (tests). Default: createAgentLoop(). */
  loop?: AgentLoop;
  /** Unified nyx.db handle for cross-process abort requests (optional). */
  db?: Database.Database;
  /** Abort-request poll interval in ms. Default 150. */
  poll_ms?: number;
  /** Fired after the child session exists and its spawned events are mirrored. */
  onSpawned?: (child: { session_id: string; parent_session_id: string }) => void;
  /** Fired after the terminal event is mirrored, before spawn() resolves. */
  onSettled?: (child_session_id: string, state: SubagentResult["state"]) => void;
  now?: () => number;
}

interface RunningChild {
  controller: AbortController;
  parent_session_id: string;
  /** Set when the abort came from outside the child's own failure paths. */
  externalAbort: boolean;
}

const ABORT_POLL_MS = 150;
const TASK_TRUNCATE = 120;

export class SubagentManagerImpl implements SubagentManager {
  private readonly cfg: SubagentsConfig;
  private readonly loop: AgentLoop;
  private readonly now: () => number;
  private readonly pollMs: number;
  /** session_id → the active turn's RunContext (lane-serial: at most one). */
  private readonly turns = new Map<string, BoundTurn>();
  /** `${session}:${turn}` → subagent tokens allocated in that parent turn. */
  private readonly turnSpend = new Map<string, number>();
  /** child session id → controller of a running subagent. */
  private readonly running = new Map<string, RunningChild>();

  constructor(private readonly deps: SubagentManagerDeps) {
    this.cfg = resolveSubagentsConfig(deps.config);
    this.loop = deps.loop ?? createAgentLoop();
    this.now = deps.now ?? Date.now;
    this.pollMs = deps.poll_ms ?? ABORT_POLL_MS;
  }

  async spawn(
    spec: SubagentSpec,
    parent_ctx: RunContext,
    parent: SubagentParentRef,
  ): Promise<SubagentResult> {
    if (typeof spec.task !== "string" || spec.task.trim().length === 0) {
      throw new SubagentError("validation_failed", "spawn: spec.task must be a non-empty string");
    }
    if (this.cfg.sandbox_sharing === "fork") {
      throw new SubagentError(
        "not_supported",
        "spawn: subagents.sandbox_sharing \"fork\" is Phase 4+; only \"inherit\" is available",
      );
    }
    const parentMeta = await parent_ctx.session.meta(parent.session_id);
    if (parentMeta === null) {
      throw new SubagentError(
        "validation_failed",
        `spawn: parent session ${parent.session_id} not found`,
      );
    }

    // ── depth (§2.4a): the parent's subagent lineage + 1 must fit. A
    //    spec's max_depth_override may only TIGHTEN the configured ceiling.
    const parentDepth = await this.depthOf(parent_ctx.session, parent.session_id);
    const ceiling = Math.min(
      this.cfg.max_depth,
      spec.max_depth_override !== undefined ? spec.max_depth_override : this.cfg.max_depth,
    );
    const childDepth = parentDepth + 1;
    if (this.cfg.max_depth === 0 || childDepth > ceiling) {
      throw new SubagentError(
        "depth_exceeded",
        `spawn rejected: depth ${childDepth} would exceed max_depth ${ceiling}` +
          (this.cfg.max_depth === 0 ? " (subagents disabled: max_depth 0)" : ""),
      );
    }

    // ── per-turn budget (§2.4b): allocation-based, checked before the child
    //    exists. A spec's budget is clamped to the ceiling — less, never more.
    const budget = Math.min(
      spec.budget_tokens ?? this.cfg.default_budget_tokens,
      this.cfg.max_budget_tokens,
    );
    const spendKey = `${parent.session_id}:${parent.turn_id}`;
    const spent = this.turnSpend.get(spendKey) ?? 0;
    if (spent + budget > this.cfg.max_total_per_turn) {
      throw new SubagentError(
        "budget_exceeded",
        `spawn rejected: this turn has ${spent} subagent tokens allocated; ` +
          `${budget} more would exceed max_total_per_turn ${this.cfg.max_total_per_turn}`,
      );
    }
    this.turnSpend.set(spendKey, spent + budget);

    // ── child session (§2.4c): kind subagent, parent lineage, persona +
    //    engagement inherited. A failed create rolls the allocation back so
    //    the turn's budget doesn't count a subagent that never existed.
    let child;
    try {
      child = await parent_ctx.session.create({
        owner_id: parentMeta.owner_id,
        persona_id: parentMeta.persona_id,
        parent_id: parent.session_id,
        kind: "subagent",
        title: `subagent: ${spec.task.slice(0, 60)}`,
        engagement: parentMeta.engagement,
      });
    } catch (err) {
      this.turnSpend.set(spendKey, spent);
      throw err;
    }

    const childTurnId = `sub-${nanoid(10)}`;
    const startedAt = this.now();
    const controller = new AbortController();
    const runningChild: RunningChild = {
      controller,
      parent_session_id: parent.session_id,
      externalAbort: false,
    };
    this.running.set(child.session_id, runningChild);

    // ── mirrored spawned events (§2.4d): child's copy first, then parent's.
    const spawnedBase = {
      subagent_session_id: child.session_id,
      turn_id: childTurnId,
      parent_session_id: parent.session_id,
      parent_turn_id: parent.turn_id,
      task: spec.task,
      depth: childDepth,
      ts: this.now(),
    };
    await parent_ctx.session.append(child.session_id, [
      { type: "subagent.spawned", session_id: child.session_id, ...spawnedBase },
    ]);
    await parent_ctx.session.append(parent.session_id, [
      { type: "subagent.spawned", session_id: parent.session_id, ...spawnedBase },
    ]);
    this.deps.onSpawned?.({
      session_id: child.session_id,
      parent_session_id: parent.session_id,
    });

    // ── child RunContext (§2.4e): filtered tools (structural), isolated
    //    memory, budget-guarded model, shared sandbox, inherited policy +
    //    approvals + persona.
    const { tools, kernel } = buildChildTooling(
      parent_ctx,
      spec.tools ?? this.cfg.default_allowed_tools,
      this.cfg,
    );
    let budgetExceeded = false;
    let parentAborted = false;
    const budgetRouter = new BudgetTrackingRouter(parent_ctx.model, budget, () => {
      budgetExceeded = true;
      controller.abort(new SubagentError("budget_exceeded", "subagent budget exceeded"));
    });
    const onParentAbort = (): void => {
      parentAborted = true;
      controller.abort(new SubagentError("aborted", "parent turn aborted"));
    };
    if (parent_ctx.signal.aborted) onParentAbort();
    else parent_ctx.signal.addEventListener("abort", onParentAbort, { once: true });

    const childCtx: RunContext = {
      kernel,
      session: parent_ctx.session,
      model: budgetRouter,
      tools,
      tool_router: {
        select: (call, available) => available.find((d) => d.name === call.name) ?? null,
      },
      policy: parent_ctx.policy,
      approvals: parent_ctx.approvals,
      sandbox: parent_ctx.sandbox,
      memory: childMemory(parent_ctx.memory, child.session_id),
      persona: parent_ctx.persona,
      signal: controller.signal,
      logger: parent_ctx.logger.child({ session_id: child.session_id, turn_id: childTurnId }),
      options: parent_ctx.options,
    };

    // ── run the child turn, harvesting summary/usage/failure from its own
    //    events while racing the cross-process abort poll (§2.4f–h).
    let summary = "";
    let tokensUsed = 0;
    let turnFailure: SerializedError | undefined;
    try {
      const iterator = this.loop.run(
        {
          session_id: child.session_id,
          turn_id: childTurnId,
          user_message: childUserMessage(spec.task),
        },
        childCtx,
      )[Symbol.asyncIterator]();
      let pending = iterator.next();
      for (;;) {
        let result: IteratorResult<SessionEvent>;
        if (this.deps.db !== undefined) {
          const winner = await Promise.race([
            pending.then((r) => ({ kind: "next" as const, r })),
            sleep(this.pollMs).then(() => ({ kind: "poll" as const })),
          ]);
          if (winner.kind === "poll") {
            for (const id of takeSubagentAbortRequests(this.deps.db)) {
              const entry = this.running.get(id);
              if (entry !== undefined) {
                entry.externalAbort = true;
                entry.controller.abort(
                  new SubagentError("aborted", "abort requested (external)"),
                );
              }
              // Requests for children this process doesn't run are drained
              // as stale — their owners already finished or live elsewhere.
            }
            continue;
          }
          result = winner.r;
        } else {
          result = await pending;
        }
        if (result.done) break;
        const ev = result.value;
        pending = iterator.next();
        if (ev.type === "message.assistant") {
          const text = ev.content
            .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          if (text.length > 0) summary = text; // the LAST assistant message wins
        } else if (ev.type === "turn.completed") {
          tokensUsed = usageTotal(ev.usage);
        } else if (ev.type === "turn.failed") {
          turnFailure = ev.error;
        }
      }
    } finally {
      parent_ctx.signal.removeEventListener("abort", onParentAbort);
      this.running.delete(child.session_id);
    }

    const durationMs = Math.max(0, this.now() - startedAt);
    const externalAbort = runningChild.externalAbort;

    // ── terminal state + mirrored terminal event (§2.4h–j).
    let state: SubagentResult["state"];
    let error: SerializedError | undefined;
    if (parentAborted || externalAbort) {
      state = "aborted";
      await this.mirror(parent_ctx, parent.session_id, child.session_id, {
        type: "subagent.aborted",
        session_id: child.session_id,
        subagent_session_id: child.session_id,
        parent_session_id: parent.session_id,
        reason: parentAborted ? "parent turn aborted" : "abort requested",
        ts: this.now(),
      });
      error = {
        name: "AbortError",
        message: parentAborted ? "parent turn aborted" : "abort requested",
        code: "aborted",
      };
    } else if (budgetExceeded) {
      state = "budget_exceeded";
      error = {
        name: "BudgetExceededError",
        message: `subagent budget of ${budget} tokens exceeded (${budgetRouter.tokensCounted} counted)`,
        code: "budget_exceeded",
      };
      await this.mirror(parent_ctx, parent.session_id, child.session_id, {
        type: "subagent.failed",
        session_id: child.session_id,
        subagent_session_id: child.session_id,
        parent_session_id: parent.session_id,
        error,
        ts: this.now(),
      });
    } else if (turnFailure !== undefined) {
      state = "failed";
      error = turnFailure;
      await this.mirror(parent_ctx, parent.session_id, child.session_id, {
        type: "subagent.failed",
        session_id: child.session_id,
        subagent_session_id: child.session_id,
        parent_session_id: parent.session_id,
        error: turnFailure,
        ts: this.now(),
      });
    } else {
      state = "completed";
      await this.mirror(parent_ctx, parent.session_id, child.session_id, {
        type: "subagent.completed",
        session_id: child.session_id,
        subagent_session_id: child.session_id,
        parent_session_id: parent.session_id,
        summary,
        tokens_used: tokensUsed,
        duration_ms: durationMs,
        ts: this.now(),
      });
    }

    this.deps.onSettled?.(child.session_id, state);
    return {
      session_id: child.session_id,
      summary,
      state,
      tokens_used: tokensUsed,
      duration_ms: durationMs,
      ...(error !== undefined ? { error } : {}),
    };
  }

  async list(parent_session_id: string): Promise<SubagentInfo[]> {
    const parentEvents = await this.deps.store.read(parent_session_id);
    const spawned = parentEvents.filter(
      (e): e is Extract<StoredEvent, { type: "subagent.spawned" }> =>
        e.type === "subagent.spawned" && e.session_id === parent_session_id,
    );
    const out: SubagentInfo[] = [];
    for (const ev of spawned) {
      const childId = ev.subagent_session_id;
      const childMeta = await this.deps.store.meta(childId);
      if (childMeta === null || childMeta.archived_at !== null) continue;
      const childEvents = await this.deps.store.read(childId);
      let state: SubagentInfo["state"] = "running";
      for (const ce of childEvents) {
        if (ce.type === "subagent.completed") state = "completed";
        else if (ce.type === "subagent.aborted") state = "aborted";
        else if (ce.type === "subagent.failed") {
          state = ce.error.code === "budget_exceeded" ? "budget_exceeded" : "failed";
        }
      }
      out.push({
        session_id: childId,
        parent_session_id: ev.parent_session_id,
        parent_turn_id: ev.parent_turn_id,
        spawned_at: ev.ts,
        state,
        task: ev.task.slice(0, TASK_TRUNCATE),
      });
    }
    return out;
  }

  async abort(subagent_session_id: string): Promise<void> {
    const entry = this.running.get(subagent_session_id);
    if (entry !== undefined) {
      entry.externalAbort = true;
      entry.controller.abort(new SubagentError("aborted", "abort requested"));
      return;
    }
    // Not running here — leave a control row for the owning process. If no
    // process owns it either, the row is drained as stale by the next poll.
    if (this.deps.db !== undefined) {
      requestSubagentAbort(this.deps.db, subagent_session_id, "subagents.abort");
    }
  }

  async depth_for(session_id: string): Promise<number> {
    const depth = await this.depthOf(this.deps.store, session_id);
    return Math.max(0, this.cfg.max_depth - depth);
  }

  bindTurn(session_id: string, turn_id: string, ctx: RunContext): void {
    this.turns.set(session_id, { turn_id, ctx });
  }

  unbindTurn(session_id: string): void {
    this.turns.delete(session_id);
    for (const key of this.turnSpend.keys()) {
      if (key.startsWith(`${session_id}:`)) this.turnSpend.delete(key);
    }
  }

  /** The bound RunContext for a session+turn — the tool path's parent. */
  boundTurn(session_id: string, turn_id: string): BoundTurn | undefined {
    const bound = this.turns.get(session_id);
    return bound !== undefined && bound.turn_id === turn_id ? bound : undefined;
  }

  /** Tokens allocated to subagents in a parent turn so far (tests/report). */
  turnSpendOf(session_id: string, turn_id: string): number {
    return this.turnSpend.get(`${session_id}:${turn_id}`) ?? 0;
  }

  // ---- internals ---------------------------------------------------------

  /** Appends the terminal event to the child's log, then the parent's. */
  private async mirror(
    parent_ctx: RunContext,
    parent_session_id: string,
    child_session_id: string,
    event: SessionEvent,
  ): Promise<void> {
    await parent_ctx.session.append(child_session_id, [event]);
    await parent_ctx.session.append(parent_session_id, [
      { ...event, session_id: parent_session_id } as SessionEvent,
    ]);
  }

  /** Number of subagent sessions in the lineage of `session_id` (inclusive). */
  private async depthOf(store: SessionStore, session_id: string): Promise<number> {
    let depth = 0;
    let id: string | null = session_id;
    const seen = new Set<string>();
    while (id !== null && !seen.has(id)) {
      seen.add(id);
      const meta = await store.meta(id);
      if (meta === null) break;
      if (meta.kind === "subagent") depth += 1;
      id = meta.parent_id;
    }
    return depth;
  }
}

function usageTotal(usage: Usage): number {
  if (usage.total_tokens !== undefined) return usage.total_tokens;
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.reasoning_tokens ?? 0) +
    (usage.cache_read_tokens ?? 0)
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createSubagentManager(deps: SubagentManagerDeps): SubagentManager {
  return new SubagentManagerImpl(deps);
}
