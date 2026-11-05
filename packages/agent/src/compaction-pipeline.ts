// SPDX-License-Identifier: AGPL-3.0-or-later
// The four-tier compaction pipeline (Phase 2 §2.2). Phase 0 shipped one
// strategy (rule-based elision); this module promotes it to Tier 1 of an
// ordered pipeline and adds the three tiers the ROADMAP promised:
//
//   Tier 1  elision        — replace old tool_result outputs with markers,
//                            then drop old reasoning (Phase 0's strategy).
//   Tier 2  session memory — a cheap model call compacts everything before
//                            the last 5 turns into one system message, written
//                            to @nyx/memory scope "session" (survives restart).
//   Tier 3  llm summary    — a cheap model call summarizes the last K messages
//                            (decisions / current task state / open questions).
//   Tier 4  emergency      — tokens still > 95% after Tiers 1–3: drop the
//                            oldest half of history (last 10 always retained),
//                            warn the operator, audit the truncation.
//
// Tiers run in order; the first non-null plan is applied. Tier 4 is the
// safety valve: it re-checks AFTER Tiers 1–3 (its precondition is explicitly
// "still exceeds after 1–3"), so it can follow another tier in the same pass.
// After any tier that drops content, up to 5 recently referenced files are
// re-read into context (capped) — an agent mid-file-edit must not lose the
// file (the Claude Code behavior).
//
// Compaction NEVER loses events: only the message list presented to the model
// is compacted. Elided content stays in the event log; recovery is
// session.read().

import type {
  CompletionRequest,
  ContentBlock,
  Logger,
  MemoryStore,
  Message,
  ModelChunk,
  ModelProvider,
  Sandbox,
  SessionEvent,
} from "@nyx/protocol";
import { elideMessages, estimateTokens } from "./compaction.js";

// ---------------------------------------------------------------------------
// Contracts (Phase 2 §3.1)
// ---------------------------------------------------------------------------

export type CompactionTier = "elision" | "session_memory" | "llm_summary" | "emergency";

export interface CompactionPlan {
  tier: CompactionTier;
  messages_to_drop: number;
  messages_to_summarize: number;
  estimated_tokens_freed: number;
  llm_call_required: boolean;
}

/** The model surface the LLM tiers need (both providers and the router fit). */
export type CompactionModel = Pick<ModelProvider, "complete">;

export interface CompactionContext {
  session_id: string;
  turn_id: string;
  messages: Message[];
  current_tokens: number;
  budget_tokens: number;
  reasoning_effort: "low" | "high" | "max";
  model: CompactionModel;
  memory: MemoryStore;
  /** Post-compaction re-read source (the session sandbox). */
  sandbox?: Sandbox;
  emit: (e: SessionEvent) => void;
  logger?: Logger;
}

export interface CompactionResult {
  /** The compacted message list (the pipeline never mutates the input). */
  messages: Message[];
  /** The tier that applied; undefined when nothing was applicable. */
  tier?: CompactionTier;
  freed_tokens: number;
}

export interface Compactor {
  readonly tier: CompactionTier;
  /** null = tier not applicable. */
  plan(ctx: CompactionContext): Promise<CompactionPlan | null>;
  apply(ctx: CompactionContext, plan: CompactionPlan): Promise<CompactionResult>;
}

export interface Pipeline {
  compact(ctx: CompactionContext): Promise<CompactionResult>;
}

// ---------------------------------------------------------------------------
// Configuration (Phase 2 §3.7)
// ---------------------------------------------------------------------------

export interface CompactionConfig {
  elision_threshold_tokens: number;
  session_memory_threshold: number; // fraction of window
  session_memory_min_turns: number;
  llm_summary_threshold: number; // fraction of window
  emergency_threshold: number; // fraction of window
  post_compaction_reread_tokens: number;
  post_compaction_reread_files: number;
  enabled: boolean;
  verbose_events: boolean;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  elision_threshold_tokens: 5_000,
  session_memory_threshold: 0.6,
  session_memory_min_turns: 20,
  llm_summary_threshold: 0.8,
  emergency_threshold: 0.95,
  post_compaction_reread_tokens: 5_000,
  post_compaction_reread_files: 5,
  enabled: true,
  verbose_events: false,
};

/** How many trailing COMPLETED turns Tier 2 leaves intact (plus the current one). */
const SESSION_MEMORY_KEEP_TURNS = 5;
/** How many messages Tier 3 summarizes. */
const LLM_SUMMARY_K = 10;
/** How many trailing turns the re-read scans for referenced files. */
const REREAD_TURN_WINDOW = 20;
/** File-touching tools whose paths are re-read after compaction. */
const REREAD_TOOLS = new Set(["fs.read", "fs.write", "fs.edit"]);

/** The protocol CompactionStrategy for a tier (frozen vocabulary). */
function strategyOf(
  tier: CompactionTier,
): "rule-elision" | "session-memory" | "llm-summary" | "emergency-degrade" {
  switch (tier) {
    case "elision":
      return "rule-elision";
    case "session_memory":
      return "session-memory";
    case "llm_summary":
      return "llm-summary";
    case "emergency":
      return "emergency-degrade";
  }
}

// ---------------------------------------------------------------------------
// Message-list helpers
// ---------------------------------------------------------------------------

type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;

function isElidableToolResult(block: ContentBlock): block is ToolResultBlock {
  return (
    block.type === "tool_result" &&
    !(block.output.kind === "text" && block.output.text.startsWith("[elided tool output"))
  );
}

/** Indices of user messages (turn anchors). */
function userMessageIndices(messages: Message[]): number[] {
  const indices: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") indices.push(i);
  });
  return indices;
}

/** Count of turns (user messages) in the list. */
function turnCount(messages: Message[]): number {
  return userMessageIndices(messages).length;
}

/**
 * The leading run of system messages (the assembled persona preamble). Tier 2
 * and Tier 4 never summarize/drop it: degrading the contract is not an
 * acceptable compaction outcome.
 */
function preambleLength(messages: Message[]): number {
  let n = 0;
  while (n < messages.length && messages[n]!.role === "system") n += 1;
  return n;
}

/** Everything before the last `keepTurns` turns (turn anchors = user messages). */
function lastTurnsStart(messages: Message[], keepTurns: number): number {
  const anchors = userMessageIndices(messages);
  if (anchors.length <= keepTurns) return 0;
  return anchors[anchors.length - keepTurns]!;
}

/** Tier 2 boundary: keep the last `completed` COMPLETED turns + the current turn. */
function sessionMemoryBoundary(messages: Message[]): number {
  return lastTurnsStart(messages, SESSION_MEMORY_KEEP_TURNS + 1);
}

/** Elidable tool_result tokens in history (excluding the current turn's tail). */
function elidableToolTokens(messages: Message[]): number {
  // The current turn's user message is the list's last user message.
  const anchors = userMessageIndices(messages);
  const currentTurnStart = anchors.length > 0 ? anchors[anchors.length - 1]! : messages.length;
  let tokens = 0;
  messages.forEach((m, i) => {
    if (i >= currentTurnStart) return;
    for (const block of m.content) {
      if (isElidableToolResult(block)) {
        tokens += Math.ceil(JSON.stringify(block).length / 4);
      }
    }
  });
  return tokens;
}

async function completeText(
  model: CompactionModel,
  messages: Message[],
  reasoning_effort: "low" | "high" | "max",
): Promise<string> {
  const request: CompletionRequest = {
    model: "auto",
    messages,
    reasoning_effort,
  };
  let text = "";
  for await (const chunk of model.complete(request) as AsyncIterable<ModelChunk>) {
    if (chunk.type === "text.delta") text += chunk.text;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Tier 1 — rule-based elision (Phase 0's strategy, promoted)
// ---------------------------------------------------------------------------

class ElisionCompactor implements Compactor {
  readonly tier = "elision" as const;

  constructor(private readonly config: CompactionConfig) {}

  async plan(ctx: CompactionContext): Promise<CompactionPlan | null> {
    const elidable = elidableToolTokens(ctx.messages);
    // Precondition (§3.2): old tool outputs total more than the threshold —
    // or we are over budget at all, in which case every elidable token counts
    // (this is exactly the Phase 0/1 trigger, preserved).
    if (elidable === 0) return null;
    if (
      elidable <= this.config.elision_threshold_tokens &&
      ctx.current_tokens <= ctx.budget_tokens
    ) {
      return null;
    }
    const target = Math.floor(ctx.budget_tokens * 0.8);
    const excess = Math.max(0, ctx.current_tokens - target);
    return {
      tier: this.tier,
      messages_to_drop: 0, // blocks are replaced in place, not messages dropped
      messages_to_summarize: 0,
      estimated_tokens_freed: Math.min(elidable, Math.max(excess, Math.ceil(elidable / 2))),
      llm_call_required: false,
    };
  }

  async apply(ctx: CompactionContext): Promise<CompactionResult> {
    const target = Math.floor(ctx.budget_tokens * 0.8);
    const elision = elideMessages(ctx.messages, target);
    if (this.config.verbose_events) {
      ctx.logger?.debug("compaction.elision.blocks", {
        elided_tool_results: elision.elidedToolResults,
        dropped_reasoning: elision.droppedReasoning,
      });
    }
    return {
      messages: elision.messages,
      tier: this.tier,
      freed_tokens: elision.freedTokens,
    };
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — session memory compaction
// ---------------------------------------------------------------------------

const SESSION_MEMORY_SYSTEM = [
  "You compact conversation history for a personal AI harness.",
  " Produce a dense running summary of the conversation so far: facts",
  " established, decisions made and their reasons, artifacts written,",
  " current task state, and open questions. Keep every identifier, path, and",
  " number exactly. Output only the summary text.",
].join("");

class SessionMemoryCompactor implements Compactor {
  readonly tier = "session_memory" as const;

  constructor(private readonly config: CompactionConfig) {}

  async plan(ctx: CompactionContext): Promise<CompactionPlan | null> {
    // Precondition (§3.3): active for more than N turns AND over the
    // session-memory fraction of the window.
    if (turnCount(ctx.messages) <= this.config.session_memory_min_turns) return null;
    if (ctx.current_tokens <= ctx.budget_tokens * this.config.session_memory_threshold) return null;
    const preamble = preambleLength(ctx.messages);
    const summarizable = Math.max(0, sessionMemoryBoundary(ctx.messages) - preamble);
    if (summarizable === 0) return null;
    return {
      tier: this.tier,
      messages_to_drop: summarizable,
      messages_to_summarize: summarizable,
      estimated_tokens_freed: Math.max(0, ctx.current_tokens - Math.floor(ctx.budget_tokens * 0.6)),
      llm_call_required: true,
    };
  }

  async apply(ctx: CompactionContext): Promise<CompactionResult> {
    const preamble = preambleLength(ctx.messages);
    const start = Math.max(preamble, sessionMemoryBoundary(ctx.messages));
    const before = estimateTokens(ctx.messages);
    const old = ctx.messages.slice(preamble, start);
    const kept = ctx.messages.slice(start);

    const summary = await completeText(
      ctx.model,
      [
        { role: "system", content: [{ type: "text", text: SESSION_MEMORY_SYSTEM }] },
        { role: "user", content: [{ type: "text", text: renderTranscript(old) }] },
      ],
      "low",
    );

    // Written to @nyx/memory scope "session" so it survives restart and can
    // be re-read (Tier 3's "session memory exists" precondition keys on it).
    await ctx.memory.write({
      scope: "session",
      kind: "episode",
      content: summary,
      source: { session_id: ctx.session_id, turn_id: ctx.turn_id },
      tags: ["compaction", "session-memory"],
    });

    const memoryMessage: Message = {
      role: "system",
      content: [
        {
          type: "text",
          text: `[session memory — compacted from ${old.length} messages before the last ${SESSION_MEMORY_KEEP_TURNS} turns; the full history stays in the event log]\n${summary}`,
        },
      ],
    };
    const messages = [...ctx.messages.slice(0, preamble), memoryMessage, ...kept];
    return {
      messages,
      tier: this.tier,
      freed_tokens: before - estimateTokens(messages),
    };
  }
}

function renderTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === "text") lines.push(`${m.role}: ${block.text}`);
      else if (block.type === "tool_use")
        lines.push(`${m.role}: [tool ${block.name}] ${JSON.stringify(block.input)}`);
      else if (block.type === "tool_result")
        lines.push(`tool: ${block.output.kind === "text" ? block.output.text : block.output.kind}`);
      else if (block.type === "reasoning") lines.push(`${m.role}: (reasoning) ${block.text}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tier 3 — LLM summary of recent messages
// ---------------------------------------------------------------------------

const LLM_SUMMARY_SYSTEM = [
  "You summarize the recent messages of an AI-harness conversation.",
  " Produce exactly three sections, each a bullet list:",
  " 'Decisions:', 'Current task state:', 'Open questions:'.",
  " Keep identifiers, paths, and numbers exactly. Output only the summary.",
].join("");

class LlmSummaryCompactor implements Compactor {
  readonly tier = "llm_summary" as const;

  constructor(private readonly config: CompactionConfig) {}

  async plan(ctx: CompactionContext): Promise<CompactionPlan | null> {
    // Precondition (§3.4): Tier 2 has been applied at least once in this
    // session (a session-memory entry exists), OR the window is past the
    // llm-summary fraction.
    const overFraction = ctx.current_tokens > ctx.budget_tokens * this.config.llm_summary_threshold;
    const hasSessionMemory = await sessionMemoryExists(ctx.memory, ctx.session_id);
    if (!overFraction && !hasSessionMemory) return null;
    // The K messages before the final (current) user message; the current
    // ask is never summarized away.
    const anchors = userMessageIndices(ctx.messages);
    if (anchors.length === 0) return null;
    const finalUser = anchors[anchors.length - 1]!;
    const end = finalUser; // exclusive
    const start = Math.max(preambleLength(ctx.messages), end - LLM_SUMMARY_K);
    if (end - start === 0) return null;
    return {
      tier: this.tier,
      messages_to_drop: end - start,
      messages_to_summarize: end - start,
      estimated_tokens_freed: Math.max(0, ctx.current_tokens - Math.floor(ctx.budget_tokens * 0.7)),
      llm_call_required: true,
    };
  }

  async apply(ctx: CompactionContext): Promise<CompactionResult> {
    const anchors = userMessageIndices(ctx.messages);
    const finalUser = anchors[anchors.length - 1] ?? ctx.messages.length;
    const start = Math.max(preambleLength(ctx.messages), finalUser - LLM_SUMMARY_K);
    const before = estimateTokens(ctx.messages);
    const window = ctx.messages.slice(start, finalUser);

    const summary = await completeText(
      ctx.model,
      [
        { role: "system", content: [{ type: "text", text: LLM_SUMMARY_SYSTEM }] },
        { role: "user", content: [{ type: "text", text: renderTranscript(window) }] },
      ],
      "low",
    );

    const summaryMessage: Message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[conversation summary — the last ${window.length} messages were compacted; full history stays in the event log]\n${summary}`,
        },
      ],
    };
    const messages = [
      ...ctx.messages.slice(0, start),
      summaryMessage,
      ...ctx.messages.slice(finalUser),
    ];
    return {
      messages,
      tier: this.tier,
      freed_tokens: before - estimateTokens(messages),
    };
  }
}

async function sessionMemoryExists(memory: MemoryStore, session_id: string): Promise<boolean> {
  const entries = await memory.list({ scope: ["session"], kind: "episode", limit: 500 });
  return entries.some(
    (e) => e.source.session_id === session_id && e.tags.includes("session-memory"),
  );
}

// ---------------------------------------------------------------------------
// Tier 4 — emergency degrade
// ---------------------------------------------------------------------------

class EmergencyCompactor implements Compactor {
  readonly tier = "emergency" as const;

  constructor(private readonly config: CompactionConfig) {}

  async plan(ctx: CompactionContext): Promise<CompactionPlan | null> {
    // Precondition (§3.5): still over the emergency fraction — the pipeline
    // only consults this tier after Tiers 1–3 have had their chance.
    if (ctx.current_tokens <= ctx.budget_tokens * this.config.emergency_threshold) return null;
    const n = ctx.messages.length;
    const keep = Math.max(10, n - Math.floor(n / 2));
    return {
      tier: this.tier,
      messages_to_drop: Math.max(0, n - keep),
      messages_to_summarize: 0,
      estimated_tokens_freed: Math.max(0, ctx.current_tokens - Math.floor(ctx.budget_tokens * 0.9)),
      llm_call_required: false,
    };
  }

  async apply(ctx: CompactionContext): Promise<CompactionResult> {
    const before = estimateTokens(ctx.messages);
    const messages = emergencyTruncate(ctx.messages);
    const freed = before - estimateTokens(messages);
    // The operator warning rides the event itself (strategy
    // "emergency-degrade") plus the logger; channels render it, the audit
    // chain records it (see @nyx/policy event-audit).
    ctx.logger?.warn("compaction.emergency", {
      session_id: ctx.session_id,
      turn_id: ctx.turn_id,
      kept: messages.length,
      dropped: ctx.messages.length - messages.length,
      freed_tokens: freed,
      note: "context still exceeded 95% of the window after tiers 1-3; oldest half of history dropped, last 10 retained",
    });
    return { messages, tier: this.tier, freed_tokens: freed };
  }
}

/**
 * Drop the oldest half of history; always retain the last 10 messages; the
 * persona preamble (leading system messages) survives when it fits ahead of
 * the retained window — degrading the contract is not an acceptable
 * emergency response.
 */
export function emergencyTruncate(messages: Message[]): Message[] {
  const n = messages.length;
  if (n <= 10) return [...messages];
  const keep = Math.max(10, n - Math.floor(n / 2)); // retain the last `keep`
  const tailStart = n - keep;
  const preamble = preambleLength(messages);
  const prefix = preamble > 0 && preamble <= tailStart ? messages.slice(0, preamble) : [];
  return [...prefix, ...messages.slice(tailStart)];
}

// ---------------------------------------------------------------------------
// Post-compaction re-read (§3.6)
// ---------------------------------------------------------------------------

/** File paths referenced by recent fs.read/fs.write/fs.edit calls, newest first. */
export function recentlyReferencedPaths(
  messages: Message[],
  turnWindow = REREAD_TURN_WINDOW,
): string[] {
  const anchors = userMessageIndices(messages);
  const windowStart = anchors.length > turnWindow ? anchors[anchors.length - turnWindow]! : 0;
  const paths: string[] = [];
  for (let i = messages.length - 1; i >= windowStart; i--) {
    for (const block of messages[i]!.content) {
      if (block.type === "tool_use" && REREAD_TOOLS.has(block.name)) {
        const input = block.input as { path?: unknown } | null;
        if (input !== null && typeof input === "object" && typeof input.path === "string") {
          if (!paths.includes(input.path)) paths.push(input.path);
        }
      }
    }
  }
  return paths;
}

async function rereadFiles(
  ctx: CompactionContext,
  config: CompactionConfig,
  messages: Message[],
): Promise<Message[]> {
  if (ctx.sandbox === undefined) return messages;
  const paths = recentlyReferencedPaths(ctx.messages).slice(0, config.post_compaction_reread_files);
  if (paths.length === 0) return messages;
  const sections: string[] = [];
  let usedTokens = 0;
  for (const path of paths) {
    try {
      const content = await ctx.sandbox.readFile(path);
      const text = content.toString("utf8");
      const tokens = Math.ceil(text.length / 4);
      if (usedTokens + tokens > config.post_compaction_reread_tokens && sections.length > 0) break;
      const capped = text.slice(0, config.post_compaction_reread_tokens * 4);
      sections.push(`### file: ${path}\n${capped}`);
      usedTokens += tokens;
      if (usedTokens >= config.post_compaction_reread_tokens) break;
    } catch {
      // Deleted/moved/unreadable: skip — the agent can re-read on demand.
    }
  }
  if (sections.length === 0) return messages;
  const reread: Message = {
    role: "system",
    content: [
      {
        type: "text",
        text: `[context re-read after compaction — the ${sections.length} most recently edited file(s), capped]\n\n${sections.join("\n\n")}`,
      },
    ],
  };
  // Insert after the preamble (before the compacted history).
  const at = Math.min(preambleLength(messages) + 1, messages.length);
  return [...messages.slice(0, at), reread, ...messages.slice(at)];
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export class CompactionPipelineImpl implements Pipeline {
  private readonly config: CompactionConfig;

  constructor(config: Partial<CompactionConfig> = {}) {
    this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config };
  }

  async compact(ctx: CompactionContext): Promise<CompactionResult> {
    if (!this.config.enabled) {
      return { messages: ctx.messages, freed_tokens: 0 };
    }
    const tiers: Array<[Compactor, CompactionContext]> = [
      [new ElisionCompactor(this.config), ctx],
      [new SessionMemoryCompactor(this.config), ctx],
      [new LlmSummaryCompactor(this.config), ctx],
    ];

    let messages = ctx.messages;
    let applied: CompactionTier | undefined;
    let freed = 0;

    for (const [compactor] of tiers) {
      const plan = await compactor.plan({
        ...ctx,
        messages,
        current_tokens: estimateTokens(messages),
      });
      if (plan === null) continue;
      ctx.emit({
        type: "compaction.started",
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        strategy: strategyOf(compactor.tier),
        ts: Date.now(),
      });
      const result = await compactor.apply({ ...ctx, messages }, plan);
      messages = result.messages;
      freed += result.freed_tokens;
      applied = compactor.tier;
      ctx.emit({
        type: "compaction.completed",
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        strategy: strategyOf(compactor.tier),
        freed_tokens: result.freed_tokens,
        ts: Date.now(),
      });
      break; // first non-null plan wins (§3.1)
    }

    // Tier 4: the safety valve — re-check AFTER Tiers 1–3 (§3.5).
    const emergency = new EmergencyCompactor(this.config);
    const emergencyCtx: CompactionContext = {
      ...ctx,
      messages,
      current_tokens: estimateTokens(messages),
    };
    const emergencyPlan = await emergency.plan(emergencyCtx);
    if (emergencyPlan !== null) {
      ctx.emit({
        type: "compaction.started",
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        strategy: "emergency-degrade",
        ts: Date.now(),
      });
      const result = await emergency.apply(emergencyCtx);
      messages = result.messages;
      freed += result.freed_tokens;
      applied = "emergency";
      ctx.emit({
        type: "compaction.completed",
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        strategy: "emergency-degrade",
        freed_tokens: result.freed_tokens,
        ts: Date.now(),
      });
    }

    if (applied === undefined) {
      return { messages, freed_tokens: 0 };
    }

    // Post-compaction re-read: mid-edit continuity (§3.6).
    messages = await rereadFiles({ ...ctx, messages }, this.config, messages);
    return { messages, tier: applied, freed_tokens: freed };
  }
}

/** The single pipeline constructor surfaces use; register it as kernel service "agent.compaction". */
export function createCompactionPipeline(config: Partial<CompactionConfig> = {}): Pipeline {
  return new CompactionPipelineImpl(config);
}

/** The kernel service name the agent loop looks the pipeline up under. */
export const COMPACTION_SERVICE = "agent.compaction";
