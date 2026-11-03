// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for the rule-based elision compaction: token estimation,
// oldest-first tool_result elision, then oldest-first reasoning drops,
// copy-on-write semantics, and the structural immunity of system sections.

import { describe, expect, it } from "vitest";
import type { ContentBlock, Message } from "@nyx/protocol";
import { elidedMarkerText, elidedToolOutput, elideMessages, estimateTokens } from "./compaction.js";

function sysMsg(text: string): Message {
  return { role: "system", content: [textBlock(text)] };
}

function userMsg(text: string): Message {
  return { role: "user", content: [textBlock(text)] };
}

function assistantMsg(blocks: ContentBlock[]): Message {
  return { role: "assistant", content: blocks };
}

function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

function reasoning(text: string): ContentBlock {
  return { type: "reasoning", text };
}

function toolResult(callId: string, text: string): ContentBlock {
  return { type: "tool_result", call_id: callId, output: { kind: "text", text } };
}

describe("estimateTokens", () => {
  it("is 0 for an empty message list", () => {
    expect(estimateTokens([])).toBe(0);
  });

  it("estimates ceil(jsonLength / 4): ~4 characters of JSON per token", () => {
    const message = userMsg("a".repeat(9));
    expect(estimateTokens([message])).toBe(Math.ceil(JSON.stringify(message).length / 4));
    expect(estimateTokens([userMsg("a".repeat(100))])).toBeGreaterThan(estimateTokens([userMsg("a")]));
    // summed per message, not just the first (chars accumulate, ceil applies once)
    const per = JSON.stringify(userMsg("a".repeat(40))).length;
    const one = estimateTokens([userMsg("a".repeat(40))]);
    const two = estimateTokens([userMsg("a".repeat(40)), userMsg("a".repeat(40))]);
    expect(one).toBe(Math.ceil(per / 4));
    expect(two).toBe(Math.ceil((per * 2) / 4));
    expect(two).toBeGreaterThan(one);
  });
});

describe("elideMessages", () => {
  it("replaces the OLDEST tool_result output first and stops as soon as the target fits", () => {
    const sys = sysMsg("system prompt");
    const old = { role: "tool", content: [toolResult("old-1", "o".repeat(400))] } satisfies Message;
    const keep = userMsg("keep me");
    const recent = { role: "tool", content: [toolResult("new-1", "n".repeat(400))] } satisfies Message;
    const messages = [sys, old, keep, recent];

    // target exactly fits after eliding only the oldest output
    const afterOldest = [
      sys,
      { ...old, content: [toolResult("old-1", elidedMarkerText("old-1"))] },
      keep,
      recent,
    ];
    const target = estimateTokens(afterOldest);

    const result = elideMessages(messages, target);

    expect(result.elidedToolResults).toBe(1);
    expect(result.droppedReasoning).toBe(0);
    expect(result.messages[1]!.content[0]).toEqual(toolResult("old-1", "[elided tool output old-1]"));
    // untouched messages are shared with the input, not copied
    expect(result.messages[0]).toBe(sys);
    expect(result.messages[3]).toBe(recent);
  });

  it("drops reasoning blocks, oldest first, after tool_result elision", () => {
    const sys = sysMsg("system prompt");
    const oldest = assistantMsg([reasoning("r".repeat(800)), textBlock("older answer")]);
    const newest = assistantMsg([reasoning("s".repeat(40)), textBlock("newer answer")]);

    // target fits after dropping only the OLDEST (and largest) reasoning block
    const afterOldest = [sys, assistantMsg([textBlock("older answer")]), newest];
    const target = estimateTokens(afterOldest);

    const result = elideMessages([sys, oldest, newest], target);

    expect(result.droppedReasoning).toBe(1);
    expect(result.elidedToolResults).toBe(0);
    expect(result.messages[1]!.content).toEqual([textBlock("older answer")]);
    expect(result.messages[2]).toBe(newest);
    expect(result.messages[2]!.content).toEqual([reasoning("s".repeat(40)), textBlock("newer answer")]);
  });

  it("removes a message reduced to an empty husk by reasoning drops", () => {
    const sys = sysMsg("system prompt");
    const withText = assistantMsg([reasoning("r".repeat(50)), textBlock("answer")]);
    const husk = assistantMsg([reasoning("t".repeat(60))]);

    const result = elideMessages([sys, withText, husk], 0);

    expect(result.droppedReasoning).toBe(2);
    expect(result.messages).toEqual([sys, assistantMsg([textBlock("answer")])]);
  });

  it("elides tool_result outputs and reasoning blocks together toward target 0", () => {
    const sys = sysMsg("system prompt");
    const history: Message[] = [
      assistantMsg([reasoning("r".repeat(100)), toolResult("c1", "x".repeat(400))]),
      { role: "tool", content: [toolResult("c2", "y".repeat(400))] } satisfies Message,
      assistantMsg([textBlock("final answer")]),
    ];

    const result = elideMessages([sys, ...history], 0);

    expect(result.elidedToolResults).toBe(2);
    expect(result.droppedReasoning).toBe(1);
    expect(result.messages[1]!.content).toEqual([toolResult("c1", "[elided tool output c1]")]);
    expect(result.messages[2]!.content).toEqual([toolResult("c2", "[elided tool output c2]")]);
    expect(result.messages[3]).toBe(history[2]);
  });

  it("never mutates the input array or its messages (copy-on-write)", () => {
    const sys = sysMsg("system prompt");
    const history: Message[] = [
      { role: "tool", content: [toolResult("c1", "o".repeat(300))] } satisfies Message,
      assistantMsg([reasoning("r".repeat(300)), textBlock("answer")]),
      { role: "tool", content: [toolResult("c2", "p".repeat(300))] } satisfies Message,
    ];
    const messages = [sys, ...history];
    const snapshot = structuredClone(messages);

    const result = elideMessages(messages, 0);

    expect(messages).toEqual(snapshot);
    expect(result.messages).not.toBe(messages);
    expect(result.elidedToolResults).toBe(2);
    expect(result.droppedReasoning).toBe(1);
    // unchanged messages are shared with the input
    expect(result.messages[0]).toBe(sys);
  });

  it("leaves system sections untouched (structurally immune)", () => {
    const sys = sysMsg("system prompt");
    const toolMsg = { role: "tool", content: [toolResult("c1", "o".repeat(300))] } satisfies Message;

    const result = elideMessages([sys, toolMsg], 0);

    expect(result.messages[0]).toBe(sys);
    expect(result.messages[0]!.content).toEqual([{ type: "text", text: "system prompt" }]);
  });

  it("skips tool_results that already carry elision markers (idempotent)", () => {
    const marked = {
      role: "tool",
      content: [toolResult("c1", "[elided tool output c1]")],
    } satisfies Message;
    const fresh = { role: "tool", content: [toolResult("c2", "o".repeat(300))] } satisfies Message;

    const first = elideMessages([marked, fresh], 0);
    expect(first.elidedToolResults).toBe(1);
    expect(first.messages[0]).toBe(marked);

    const second = elideMessages(first.messages, 0);
    expect(second.elidedToolResults).toBe(0);
  });

  it("reports freed tokens as the estimate delta", () => {
    const messages = [
      sysMsg("sys"),
      { role: "tool", content: [toolResult("c1", "o".repeat(400))] } satisfies Message,
    ];
    const before = estimateTokens(messages);

    const result = elideMessages(messages, 0);

    expect(result.freedTokens).toBe(before - estimateTokens(result.messages));
    expect(result.freedTokens).toBeGreaterThan(0);
  });

  it("returns the same array reference when nothing is elidable", () => {
    const messages = [sysMsg("sys"), userMsg("hello")];

    const result = elideMessages(messages, 0);

    expect(result.messages).toBe(messages);
    expect(result.freedTokens).toBe(0);
    expect(result.elidedToolResults).toBe(0);
    expect(result.droppedReasoning).toBe(0);
  });
});

describe("elision markers", () => {
  it("elidedToolOutput produces the marker text output", () => {
    expect(elidedMarkerText("c9")).toBe("[elided tool output c9]");
    expect(elidedToolOutput("c9")).toEqual({ kind: "text", text: "[elided tool output c9]" });
  });
});
