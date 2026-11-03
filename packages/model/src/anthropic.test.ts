// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CompletionRequest, ModelChunk } from "@nyx/protocol";
import { toSafeSerializedError } from "./redact.js";
import { AnthropicProvider } from "./anthropic.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function sse(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function collect(iter: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

const testMessages: CompletionRequest["messages"] = [
  { role: "system", content: [{ type: "text", text: "You are terse." }] },
  {
    role: "user",
    content: [
      { type: "text", text: "Weather in Paris?" },
      { type: "image", mime: "image/png", data_base64: "aGVsbG8=" },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "model-private" },
      { type: "tool_use", call_id: "toolu_prev", name: "get_weather", input: { city: "Paris" } },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool_result", call_id: "toolu_prev", output: { kind: "text", text: "20C sunny" } },
    ],
  },
];

describe("AnthropicProvider (local HTTP server)", () => {
  let server: Server;
  let baseUrl = "";
  let lastBody = "";
  let status = 200;
  let streamScript: ((res: ServerResponse) => void) | undefined;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = await readBody(req);
      if (req.url === "/v1/messages") {
        lastBody = body;
        if (status !== 200) {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              type: "error",
              error: { type: "overloaded_error", message: "overloaded with key sk-abcdefgh12345678" },
            }),
          );
          return;
        }
        if (streamScript) {
          streamScript(res);
          return;
        }
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "nope" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function makeProvider(): AnthropicProvider {
    return new AnthropicProvider({
      id: "anthropic-test",
      apiKey: "test-key",
      models: [{ id: "claude-test", context_window: 200000, max_output: 8192, supports: ["tools", "vision"] }],
      baseUrl,
    });
  }

  it("maps a full Messages SSE stream to the ModelChunk sequence", async () => {
    streamScript = (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
      sse(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      });
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Pondering the weather." },
      });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 1 });
      sse(res, "content_block_start", {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      });
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"ci' },
      });
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: 'ty":"Paris"}' },
      });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 2 });
      sse(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 7 },
      });
      sse(res, "message_stop", { type: "message_stop" });
      res.end();
    };
    status = 200;
    const provider = makeProvider();
    const chunks = await collect(
      provider.complete({
        model: "claude-test",
        messages: testMessages,
        tools: [
          { name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } },
        ],
        temperature: 0.1,
        max_tokens: 256,
      }),
    );
    expect(chunks).toEqual([
      { type: "reasoning.delta", text: "Pondering the weather." },
      { type: "text.delta", text: "Hel" },
      { type: "text.delta", text: "lo" },
      { type: "tool_call.delta", index: 2, id: "toolu_1", name: "get_weather" },
      { type: "tool_call.delta", index: 2, arguments_delta: '{"ci' },
      { type: "tool_call.delta", index: 2, arguments_delta: 'ty":"Paris"}' },
      { type: "usage", usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } },
      { type: "done", finish_reason: "tool_calls" },
    ]);

    // Verify the outbound request mapping.
    const sent = JSON.parse(lastBody);
    expect(sent.model).toBe("claude-test");
    expect(sent.max_tokens).toBe(256);
    expect(sent.temperature).toBe(0.1);
    expect(sent.stream).toBe(true);
    expect(sent.system).toBe("You are terse.");
    expect(sent.tools).toEqual([
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
    expect(sent.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Weather in Paris?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_prev", name: "get_weather", input: { city: "Paris" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_prev", content: "20C sunny" }],
      },
    ]);
    streamScript = undefined;
  });

  it("classifies HTTP error responses and redacts leaked key material", async () => {
    status = 529;
    streamScript = undefined;
    const provider = makeProvider();
    const err = await collect(provider.complete({ model: "claude-test", messages: testMessages })).then(
      () => undefined,
      (e: unknown) => e,
    );
    const ser = toSafeSerializedError(err);
    expect(ser.code).toBe("server_error");
    expect(ser.retryable).toBe(true);
    expect(ser.message).not.toContain("sk-abcdefgh12345678");
    expect(ser.message).toContain("sk-[redacted]");
    status = 200;
  });

  it("ends iteration with an aborted error when the signal fires mid-stream", async () => {
    streamScript = (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "message_start", {
        type: "message_start",
        message: {
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
      let i = 0;
      const timer = setInterval(() => {
        i += 1;
        if (i > 10) {
          clearInterval(timer);
          res.end();
          return;
        }
        sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `t${i} ` } });
      }, 20);
    };
    const provider = makeProvider();
    const controller = new AbortController();
    const chunks: ModelChunk[] = [];
    const err = await (async () => {
      try {
        for await (const chunk of provider.complete({
          model: "claude-test",
          messages: testMessages,
          signal: controller.signal,
        })) {
          chunks.push(chunk);
          if (chunks.length === 2) controller.abort();
        }
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(chunks.length).toBe(2);
    const ser = toSafeSerializedError(err);
    expect(ser.code).toBe("aborted");
    expect(ser.retryable).toBe(false);
    streamScript = undefined;
  });
});
