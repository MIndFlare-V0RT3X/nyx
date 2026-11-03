// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { ModelChunk } from "@nyx/protocol";
import { toSafeSerializedError } from "./redact.js";
import {
  mockFailTurn,
  mockTextAndToolTurn,
  mockTextTurn,
  mockToolTurn,
  MockProvider,
} from "./mock.js";

async function collect(iter: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

const req = {
  model: "mock-1",
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
};

describe("MockProvider", () => {
  it("streams a scripted two-turn conversation (tool turn, then text turn) in exact order", async () => {
    const provider = new MockProvider("mock", [
      mockToolTurn({ call_id: "call_1", name: "get_weather", input: { city: "Paris" } }),
      mockTextTurn("It is sunny in Paris."),
    ]);

    const first = await collect(provider.complete(req));
    expect(first).toEqual([
      {
        type: "tool_call.delta",
        index: 0,
        id: "call_1",
        name: "get_weather",
        arguments_delta: '{"city":',
      },
      { type: "tool_call.delta", index: 0, arguments_delta: '"Paris"}' },
      { type: "usage", usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 } },
      { type: "done", finish_reason: "tool_calls" },
    ]);

    const second = await collect(provider.complete(req));
    expect(second.map((c) => c.type)).toEqual(["text.delta", "text.delta", "usage", "done"]);
    expect(second[0]).toEqual({ type: "text.delta", text: "It is sunny" });
    expect(second[1]).toEqual({ type: "text.delta", text: " in Paris." });
    expect(second[3]).toEqual({ type: "done", finish_reason: "stop" });
  });

  it("yields text-then-tool chunks from mockTextAndToolTurn", async () => {
    const provider = new MockProvider("mock", [
      mockTextAndToolTurn("Checking…", { call_id: "c2", name: "search", input: { q: "nyx" } }),
    ]);
    const chunks = await collect(provider.complete(req));
    const types = chunks.map((c) => c.type);
    expect(types).toEqual([
      "text.delta",
      "text.delta",
      "tool_call.delta",
      "tool_call.delta",
      "usage",
      "done",
    ]);
    expect(chunks[5]).toEqual({ type: "done", finish_reason: "tool_calls" });
  });

  it("throws a typed provider_error when the script is exhausted", async () => {
    const provider = new MockProvider("mock", [mockTextTurn("one")]);
    await collect(provider.complete(req));
    await expect(collect(provider.complete(req))).rejects.toMatchObject({
      name: "ProviderError",
      message: "mock script exhausted",
      code: "provider_error",
      retryable: false,
    });
  });

  it("throws fail turns with their serialized code and retryability preserved", async () => {
    const provider = new MockProvider("mock", [
      mockFailTurn(
        Object.assign(new Error("upstream melted key sk-abcdefgh12345678"), {
          code: "server_error",
          retryable: true,
        }),
      ),
    ]);
    const err = await collect(provider.complete(req)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const ser = toSafeSerializedError(err);
    expect(ser.code).toBe("server_error");
    expect(ser.retryable).toBe(true);
    expect(ser.message).not.toContain("sk-abcdefgh12345678");
  });

  it("returns the declared model list or the default mock model", async () => {
    expect(await new MockProvider("mock", []).listModels()).toEqual([
      {
        id: "mock-1",
        context_window: 128000,
        max_output: 8192,
        supports: ["tools", "streaming_tools"],
      },
    ]);
    const declared = [
      { id: "custom", context_window: 4096, max_output: 1024, supports: ["tools" as const] },
    ];
    expect(await new MockProvider("mock", [], { models: declared }).listModels()).toEqual(declared);
  });

  it("does not mutate the script passed to the constructor", async () => {
    const script = [mockTextTurn("a")];
    const provider = new MockProvider("mock", script);
    await collect(provider.complete(req));
    expect(script).toHaveLength(1);
  });
});
