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
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AgentLoop,
  ApprovalEngine,
  ContentBlock,
  RunContext,
  Sandbox,
  SerializedError,
  SessionEvent,
  SessionStore,
  StoredEvent,
  SubagentArtifactRef,
  SubagentInfo,
  SubagentResult,
  SubagentSpec,
  Usage,
} from "@nyx/protocol";
import { toSerializedError } from "@nyx/protocol";
import { createAgentLoop } from "@nyx/agent";
import { ARTIFACTS_DIR, ensureArtifactsDir, forkSandbox } from "@nyx/sandbox";
import {
  MAX_ARTIFACT_BYTES,
  artifactNameOf,
  auditArtifactRead,
  lastWrittenHash,
  subagentArtifactTool,
} from "./artifacts.js";
import {
  BudgetTrackingRouter,
  buildChildTooling,
  childMemory,
  childUserMessage,
} from "./child-views.js";
import { resolveSubagentsConfig, type SubagentsConfig } from "./config.js";
import {
  requestSubagentAbort,
  listSubagentAbortRequests,
  deleteSubagentAbortRequest,
} from "./control.js";
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
  /**
   * Phase 4 §4: the verified artifact handoff — copy a child's published
   * artifact into the parent's sandbox after matching the audited sha256.
   * `reader_session_id` is the requesting session (the tool path's
   * ToolContext): the read is parentage-checked against it.
   */
  readChildArtifact(
    subagent_session_id: string,
    path: string,
    dest: string | undefined,
    reader_session_id: string,
    parent_ctx: RunContext,
  ): Promise<{ dest: string; bytes: number; sha256: string }>;
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
  /** The parent turn's approval engine — used to unblock ask-waits on abort. */
  approvals: ApprovalEngine | undefined;
  /** Set when the abort came from outside the child's own failure paths. */
  externalAbort: boolean;
  /** Human-readable abort cause for the mirrored subagent.aborted event. */
  abortReason: string;
}

const ABORT_POLL_MS = 150;
const TASK_TRUNCATE = 120;
/**
 * Phase 4 §4: how many settled children's sandboxes stay readable for the
 * artifact handoff (LRU). Beyond the cap the oldest is destroyed — its
 * artifacts are gone and a late read fails not_found. Documented in
 * SUBAGENTS.md; a per-child sandbox is a directory on disk, so the cap is
 * the leak bound.
 */
const MAX_RETAINED_CHILD_SANDBOXES = 8;

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
  /** Phase 4 §4: settled child session id → its (forked) sandbox, for reads. */
  private readonly childSandboxes = new Map<
    string,
    { sandbox: Sandbox; parent_session_id: string; at: number }
  >();

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
    // Budget floor (fan-out review R1): the allocation arithmetic below only
    // holds for positive integers — a negative spec budget would poison the
    // per-turn spend downward and buy room against max_total_per_turn that
    // was never granted. The tool layer additionally enforces the advertised
    // schema minimum (1024) for model-authored specs; the manager accepts any
    // positive integer so surfaces/tests may use small budgets deliberately.
    if (
      spec.budget_tokens !== undefined &&
      (!Number.isInteger(spec.budget_tokens) || spec.budget_tokens < 1)
    ) {
      throw new SubagentError(
        "validation_failed",
        `spawn: spec.budget_tokens must be a positive integer (got ${String(spec.budget_tokens)})`,
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

    // ── Phase 4 §4: the fork — BEFORE the child session exists. A sandbox
    //    that cannot fork is a CONFIGURATION error, not a child failure:
    //    spawn() rejects with not_supported before anything is created, and
    //    there is never a half-built child for it. forkSandbox never falls
    //    back to sharing — the refusal is the point. Any failure between the
    //    fork and the child's existence (fork itself, the artifacts dir, the
    //    session create) destroys the forked sandbox and rolls the turn's
    //    budget allocation back — a subagent that never existed is never
    //    charged, and an untracked sandbox is never orphaned (§6.2 R4-2/4).
    let childSandbox: Sandbox | undefined;
    if (this.cfg.sandbox_sharing === "fork") {
      try {
        childSandbox = await forkSandbox(parent_ctx.sandbox);
        await ensureArtifactsDir(childSandbox);
      } catch (err) {
        this.turnSpend.set(spendKey, spent);
        // R4-2: if the fork itself succeeded but a later step here threw, the
        // forked sandbox is real and untracked — destroy it BEFORE the
        // rethrow so no orphan ever escapes the retention bound. (If
        // forkSandbox threw, childSandbox is undefined and this is a no-op.)
        if (childSandbox !== undefined) {
          await childSandbox.destroy().catch(() => undefined);
        }
        throw err;
      }
    }

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
      if (childSandbox !== undefined) {
        await childSandbox.destroy().catch(() => undefined); // the fork is now orphaned
      }
      throw err;
    }
    if (childSandbox !== undefined) {
      this.childSandboxes.set(child.session_id, {
        sandbox: childSandbox,
        parent_session_id: parent.session_id,
        at: this.now(),
      });
      this.reapChildSandboxes();
    }

    const childTurnId = `sub-${nanoid(10)}`;
    const startedAt = this.now();
    const controller = new AbortController();
    const runningChild: RunningChild = {
      controller,
      parent_session_id: parent.session_id,
      approvals: parent_ctx.approvals,
      externalAbort: false,
      abortReason: "abort requested",
    };
    this.running.set(child.session_id, runningChild);

    // From here to settle, the child is tracked as running; any throw on the
    // way (a failed append, a broken child-context build) must not leave a
    // dead entry behind — list() would report it "running" forever. The
    // harvest + abort state is hoisted so the finally and the terminal-state
    // section below can see it.
    let budgetExceeded = false;
    let parentAborted = false;
    const onParentAbort = (): void => {
      parentAborted = true;
      this.abortChild(
        runningChild,
        child.session_id,
        "parent turn aborted",
        new SubagentError("aborted", "parent turn aborted"),
      );
    };
    let summary = "";
    let tokensUsed = 0;
    let turnFailure: SerializedError | undefined;
    let budgetRouter: BudgetTrackingRouter | undefined;
    try {
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
      //    memory, budget-guarded model, inherited policy + approvals +
      //    persona. In fork mode the child's toolset additionally carries
      //    subagent_artifact — the ONLY way files leave its sandbox — wired
      //    through buildChildTooling so BOTH the registry the model sees and
      //    the runtime that executes carry it; the sandbox itself was forked
      //    above, before the child existed.
      const artifactExtra =
        this.cfg.sandbox_sharing === "fork"
          ? [
              subagentArtifactTool({
                sandbox: childSandbox!,
                child_session_id: child.session_id,
                db: this.deps.db,
                now: () => this.now(),
              }),
            ]
          : [];
      const { tools: childTools, kernel } = buildChildTooling(
        parent_ctx,
        spec.tools ?? this.cfg.default_allowed_tools,
        this.cfg,
        artifactExtra,
      );
      budgetRouter = new BudgetTrackingRouter(parent_ctx.model, budget, () => {
        budgetExceeded = true;
        this.abortChild(
          runningChild,
          child.session_id,
          "subagent budget exceeded",
          new SubagentError("budget_exceeded", "subagent budget exceeded"),
        );
      });
      if (parent_ctx.signal.aborted) onParentAbort();
      else parent_ctx.signal.addEventListener("abort", onParentAbort, { once: true });

      const childCtx: RunContext = {
        kernel,
        session: parent_ctx.session,
        model: budgetRouter,
        tools: childTools,
        tool_router: {
          select: (call, available) => available.find((d) => d.name === call.name) ?? null,
        },
        policy: parent_ctx.policy,
        approvals: parent_ctx.approvals,
        sandbox: childSandbox ?? parent_ctx.sandbox,
        memory: childMemory(parent_ctx.memory, child.session_id),
        persona: parent_ctx.persona,
        signal: controller.signal,
        logger: parent_ctx.logger.child({ session_id: child.session_id, turn_id: childTurnId }),
        options: parent_ctx.options,
      };

      // ── run the child turn, harvesting summary/usage/failure from its own
      //    events while racing the cross-process abort poll (§2.4f–h). The
      //    poll deadline is checked at the TOP of the loop from a last-poll
      //    timestamp: a fresh sleep raced against event delivery loses every
      //    race while the child streams faster than poll_ms, which would
      //    starve the cross-process abort for as long as the stream lasts.
      const runner = this.loop.run(
        {
          session_id: child.session_id,
          turn_id: childTurnId,
          user_message: childUserMessage(spec.task),
        },
        childCtx,
      );
      const iterator = runner[Symbol.asyncIterator]();
      let pending = iterator.next();
      let lastPoll = this.now();
      for (;;) {
        if (this.deps.db !== undefined && this.now() - lastPoll >= this.pollMs) {
          lastPoll = this.now();
          await this.drainAbortRequests();
        }
        let result: IteratorResult<SessionEvent>;
        if (this.deps.db === undefined) {
          result = await pending;
        } else {
          const waitMs = Math.max(1, this.pollMs - (this.now() - lastPoll));
          const winner = await Promise.race([
            pending.then((r) => ({ kind: "next" as const, r })),
            sleep(waitMs).then(() => ({ kind: "poll" as const })),
          ]);
          if (winner.kind === "poll") continue; // loop head decides + drains
          result = winner.r;
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
    } catch (err) {
      // A throw anywhere AFTER the child exists (a failed mirrored append, a
      // broken child-context build, a loop that explodes before its own
      // try/catch) is the CHILD's failure per §2.4i — not a spawn() rejection.
      // Recording it here and falling through to the terminal section mirrors
      // subagent.failed and returns state="failed", so a mid-flight throw can
      // never leave the child "running" forever (fan-out review R1/R2).
      turnFailure = toSerializedError(err);
    } finally {
      parent_ctx.signal.removeEventListener("abort", onParentAbort);
      this.running.delete(child.session_id);
    }

    const durationMs = Math.max(0, this.now() - startedAt);
    const externalAbort = runningChild.externalAbort;

    // ── terminal state + mirrored terminal event (§2.4h–j). The whole
    //    section is failure-finalized (§6.2 R4-6): a throw in a terminal
    //    append must not escape spawn() raw — that would leave the child
    //    "running" forever in list(), skip onSettled, and hand the parent a
    //    tool.error instead of a SubagentResult. A failed terminal mirror
    //    degrades the result to state="failed" with the append error.
    let state: SubagentResult["state"];
    let error: SerializedError | undefined;
    try {
      if (parentAborted || externalAbort) {
        state = "aborted";
        await this.mirror(parent_ctx, parent.session_id, child.session_id, {
          type: "subagent.aborted",
          session_id: child.session_id,
          subagent_session_id: child.session_id,
          parent_session_id: parent.session_id,
          reason: parentAborted ? "parent turn aborted" : runningChild.abortReason,
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
          message: `subagent budget of ${budget} tokens exceeded (${budgetRouter?.tokensCounted ?? 0} counted)`,
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
    } catch (err) {
      state = "failed";
      error =
        error !== undefined
          ? error
          : toSerializedError(
              new SubagentError(
                "spawn_failed",
                `terminal event append failed for subagent ${child.session_id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            );
    }

    try {
      this.deps.onSettled?.(child.session_id, state);
    } catch {
      // A hook failure never masks the child's own result.
    }
    // Phase 4 §4: what the child published — the artifact listing rides on
    // the result (path + bytes; the sha256s live on the audit chain and are
    // re-verified on every read). In inherit mode there is no artifacts/
    // channel: the field is present and empty, so callers never branch on
    // undefined vs missing.
    let artifacts: SubagentArtifactRef[] = [];
    const retained = this.childSandboxes.get(child.session_id);
    if (retained !== undefined) {
      try {
        const entries = await retained.sandbox.list(ARTIFACTS_DIR);
        artifacts = entries
          .filter((e) => e.type === "file")
          .map((e) => ({ path: `${ARTIFACTS_DIR}/${e.name}`, bytes: e.size }));
      } catch {
        // Listing is best-effort: a sandbox that cannot be listed reports
        // no artifacts, and reads fail loudly on their own if attempted.
      }
    }
    return {
      session_id: child.session_id,
      summary,
      state,
      tokens_used: tokensUsed,
      duration_ms: durationMs,
      ...(error !== undefined ? { error } : {}),
      artifacts,
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
      this.abortChild(
        entry,
        subagent_session_id,
        "abort requested",
        new SubagentError("aborted", "abort requested"),
      );
      return;
    }
    // Not running here — leave a control row for the owning process. If no
    // process owns it either, the row is deleted by the next poll once the
    // session is provably settled (or unknown).
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

  /**
   * Phase 4 §4 — the verified artifact handoff. Copies a child's published
   * artifact into the PARENT's sandbox, but only after recomputing the
   * content hash and matching it against the one recorded at the write
   * source on the audit chain. Tampered, corrupted, evicted or unverifiable
   * artifacts are refused — never silently passed through. Only the child's
   * OWN parent may read (§6.2 R5-1: the map is process-global; parentage is
   * checked per read, mirroring list()'s scoping).
   */
  async readChildArtifact(
    subagent_session_id: string,
    path: string,
    dest: string | undefined,
    reader_session_id: string,
    parent_ctx: RunContext,
  ): Promise<{ dest: string; bytes: number; sha256: string }> {
    const name = artifactNameOf(path);
    const retained = this.childSandboxes.get(subagent_session_id);
    if (retained === undefined) {
      throw new SubagentError(
        "not_found",
        `no readable sandbox for subagent ${subagent_session_id} (unknown session or its sandbox was reaped past the retention cap)`,
      );
    }
    if (retained.parent_session_id !== reader_session_id) {
      throw new SubagentError(
        "not_found",
        `subagent ${subagent_session_id} is not a child of the requesting session — refusing the cross-session artifact read`,
      );
    }
    const written = lastWrittenHash(this.deps.db, subagent_session_id, name);
    if (written === undefined) {
      throw new SubagentError(
        "not_found",
        `no audited artifact "${name}" for subagent ${subagent_session_id} (unaudited handoffs are refused)`,
      );
    }
    const content = await retained.sandbox.readFile(`${ARTIFACTS_DIR}/${name}`);
    if (content.length > MAX_ARTIFACT_BYTES) {
      throw new SubagentError(
        "validation_failed",
        `artifact "${name}" is ${content.length} bytes — above the ${MAX_ARTIFACT_BYTES}-byte handoff cap`,
      );
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (sha256 !== written.sha256) {
      throw new SubagentError(
        "artifact_integrity",
        `artifact "${name}" of subagent ${subagent_session_id} failed hash verification ` +
          `(audited ${written.sha256.slice(0, 12)}…, read ${sha256.slice(0, 12)}…): refusing the handoff`,
      );
    }
    // The full session id in the default dest — an 8-char prefix could
    // collide and silently overwrite an earlier child's copy (§6.2 R5-6).
    const target =
      dest !== undefined && dest.length > 0
        ? dest
        : `${ARTIFACTS_DIR}/${subagent_session_id}/${name}`;
    // Audit BEFORE the bytes move (§6.2 R5-10): if the append fails, no
    // handoff happened — fail-closed, like the write side.
    if (this.deps.db !== undefined) {
      auditArtifactRead(
        this.deps.db,
        {
          reader_session_id,
          child_session_id: subagent_session_id,
          path: name,
          dest: target,
          sha256,
          bytes: content.length,
        },
        () => this.now(),
      );
    }
    await parent_ctx.sandbox.writeFile(target, content);
    return { dest: target, bytes: content.length, sha256 };
  }

  /**
   * Leak bound: destroy the oldest retained child sandboxes past the cap —
   * but NEVER a sandbox whose child is still running (§6.2 R4-1: the map is
   * populated at spawn time, before the child turn runs; evicting a running
   * child's sandbox would destroy its work mid-flight).
   */
  private reapChildSandboxes(): void {
    while (this.childSandboxes.size > MAX_RETAINED_CHILD_SANDBOXES) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [key, entry] of this.childSandboxes) {
        if (this.running.has(key)) continue; // live work is untouchable
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break; // only running children remain — over cap, by design bounded by concurrency
      const evicted = this.childSandboxes.get(oldestKey)!;
      this.childSandboxes.delete(oldestKey);
      void evicted.sandbox.destroy().catch(() => {
        // Best-effort: the sandbox's own TTL/host cleanup is the backstop.
      });
    }
  }

  // ---- internals ---------------------------------------------------------

  /**
   * One abort path, four callers (parent signal / budget / in-process /
   * cross-process). Besides firing the controller it withdraws the child's
   * pending approvals: a child blocked in approvals.request() is not racing
   * the signal there (the Phase 2 runtime awaits the engine directly), so
   * without the withdraw the abort would only take effect at approval TTL.
   */
  private abortChild(
    entry: RunningChild,
    childSessionId: string,
    reason: string,
    err: SubagentError,
  ): void {
    entry.abortReason = reason;
    entry.controller.abort(err);
    try {
      entry.approvals?.withdrawSession?.(childSessionId, reason);
    } catch {
      // Best-effort: the controller is already aborted. A withdraw failure
      // only means the pending approval settles on its own (TTL/resolution).
    }
  }

  /**
   * Applies pending cross-process abort requests THIS process can act on.
   * Rows for children owned by other processes are left in place — their
   * owner's poll must see them (a drain-all read here would let a bystander
   * manager delete a request its owner had not yet seen; fan-out review R2).
   * Rows naming settled or unknown sessions can never apply and are deleted.
   */
  private async drainAbortRequests(): Promise<void> {
    const db = this.deps.db;
    if (db === undefined) return;
    for (const row of listSubagentAbortRequests(db)) {
      const entry = this.running.get(row.session_id);
      if (entry !== undefined) {
        entry.externalAbort = true;
        this.abortChild(
          entry,
          row.session_id,
          "abort requested (external)",
          new SubagentError("aborted", "abort requested (external)"),
        );
        deleteSubagentAbortRequest(db, row.session_id);
        continue;
      }
      if (await this.isSettledOrUnknown(row.session_id)) {
        deleteSubagentAbortRequest(db, row.session_id);
      }
    }
  }

  /** True when the session already has a terminal subagent.* event (or does not exist). */
  private async isSettledOrUnknown(sessionId: string): Promise<boolean> {
    try {
      const events = await this.deps.store.read(sessionId);
      return events.some(
        (e) =>
          e.type === "subagent.completed" ||
          e.type === "subagent.failed" ||
          e.type === "subagent.aborted",
      );
    } catch {
      return true; // unreadable/nonexistent — the row can never apply
    }
  }

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
