// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 0 compaction: rule-based elision ONLY. The oldest tool_result outputs
// are replaced with short markers first, then the oldest reasoning blocks are
// dropped, until the estimate fits the target or nothing elidable remains.
// There is deliberately no router-based summarization step in this build
// (documented delta from the original brief); the other CompactionStrategy
// values ("llm-summary", "session-memory", "emergency-degrade") remain
// protocol seams for later phases.
//
// Elision is copy-on-write: the input Message[] is never mutated (history
// objects are shared with the projection and with hook closures).

import type { ContentBlock, Message, ToolOutput } from "@nyx/protocol";

/** Rough token estimate: 4 characters of JSON ≈ 1 token, summed per message. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += JSON.stringify(message).length;
  }
  return Math.ceil(chars / 4);
}

/** The marker text an elided tool_result output is replaced with. */
export function elidedMarkerText(callId: string): string {
  return `[elided tool output ${callId}]`;
}

/** The marker an elided tool_result output is replaced with. */
export function elidedToolOutput(callId: string): ToolOutput {
  return { kind: "text", text: elidedMarkerText(callId) };
}

export interface ElisionResult {
  /** The elided message list (the input array itself, or a copy-on-write derivative). */
  messages: Message[];
  /** Token estimate freed by the elision. */
  freedTokens: number;
  /** tool_result outputs that were replaced with markers. */
  elidedToolResults: number;
  /** reasoning blocks that were dropped. */
  droppedReasoning: number;
}

/**
 * Rule-based elision toward `targetTokens` ( callers pass 80% of the
 * compaction budget). System sections never contain tool_result or reasoning
 * blocks, so they are structurally immune; only history content is affected.
 */
export function elideMessages(messages: Message[], targetTokens: number): ElisionResult {
  const before = estimateTokens(messages);
  let current = messages;
  let elided = 0;
  let dropped = 0;

  // Phase 1: replace tool_result outputs, oldest messages first, blocks in order.
  current = runPass(current, targetTokens, isElidableToolResult, (block) => {
    elided += 1;
    return {
      type: "tool_result",
      call_id: block.call_id,
      output: elidedToolOutput(block.call_id),
    } satisfies ContentBlock;
  });

  // Phase 2: drop reasoning blocks, oldest first.
  current = runPass(current, targetTokens, (block) => block.type === "reasoning", (block) => {
    dropped += 1;
    return null;
  });

  return {
    messages: current,
    freedTokens: before - estimateTokens(current),
    elidedToolResults: elided,
    droppedReasoning: dropped,
  };
}

type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;

function isElidableToolResult(block: ContentBlock): block is ToolResultBlock {
  if (block.type !== "tool_result") return false;
  const output = block.output;
  return !(output.kind === "text" && output.text === elidedMarkerText(block.call_id));
}

/** null rewrite = drop the block; a block rewrite replaces it in place. */
type Rewrite = ContentBlock | null;

function runPass<B extends ContentBlock>(
  messages: Message[],
  target: number,
  isCandidate: (block: ContentBlock) => block is B,
  rewrite: (block: B) => Rewrite,
): Message[] {
  let current = messages;
  for (let mi = 0; mi < current.length; ) {
    let bi = 0;
    let changed = false;
    while (bi < current[mi]!.content.length) {
      const message = current[mi]!;
      const block = message.content[bi]!;
      if (!isCandidate(block)) {
        bi += 1;
        continue;
      }
      const replacement = rewrite(block);
      const content =
        replacement === null
          ? [...message.content.slice(0, bi), ...message.content.slice(bi + 1)]
          : [...message.content.slice(0, bi), replacement, ...message.content.slice(bi + 1)];
      current = replaceAt(current, mi, { ...message, content });
      changed = true;
      if (estimateTokens(current) <= target) return current;
      if (replacement !== null) bi += 1;
      // else: the next block shifted into index bi — re-examine it
    }
    if (changed && current[mi]!.content.length === 0) {
      // A message reduced to an empty husk (pure-reasoning assistant message)
      // is dropped entirely: empty-content messages are rejected by providers.
      current = [...current.slice(0, mi), ...current.slice(mi + 1)];
    } else {
      mi += 1;
    }
  }
  return current;
}

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  return [...items.slice(0, index), value, ...items.slice(index + 1)];
}
