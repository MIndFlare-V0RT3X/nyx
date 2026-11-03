// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CompletionRequest, ModelChunk } from "@nyx/protocol";
import { toSafeSerializedError } from "./redact.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function sse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const baseChunk = {
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  created: 1700000000,
  model: "local-model-a",
};

/** Full scripted SSE completion: reasoning, text, split tool_call, usage, finish. */
function scriptFullStream(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  sse(res, { ...baseChunk, choices: [{ index: 0, delta: { reasoning_content: "Thinking about Paris." }, finish_reason: null }] });
  sse(res, { ...baseChunk, choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] });
  sse(res, { ...baseChunk, choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] });
  sse(res, {
    ...baseChunk,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"ci' } },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  sse(res, {
    ...baseChunk,
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] },
        finish_reason: null,
      },
    ],
  });
  sse(res, { ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  sse(res, {
    ...baseChunk,
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
  res.write("data: [DONE]\n\n");
  res.end();
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
      { type: "tool_use", call_id: "call_1", name: "get_weather", input: { city: "Paris" } },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool_result", call_id: "call_1", output: { kind: "text", text: "20C sunny" } }],
  },
];

async function collect(iter: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

describe("OpenAICompatibleProvider (local HTTP server)", () => {
  let server: Server;
  let baseUrl = "";
  const bodies: Array<{ url: string; body: string }> = [];
  let handler: Handler = () => {};

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = await readBody(req);
      if (body.length > 0) bodies.push({ url: req.url ?? "", body });
      handler(req, res, body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("maps an SSE completion stream to the exact ModelChunk sequence", async () => {
    handler = (req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "local-model-a" }, { id: "local-model-b" }] }));
        return;
      }
      scriptFullStream(res);
    };
    const provider = new OpenAICompatibleProvider({ id: "local", baseUrl });
    const req: CompletionRequest = {
      model: "local-model-a",
      messages: testMessages,
      tools: [
        { name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } },
      ],
      temperature: 0.2,
      max_tokens: 512,
    };
    const chunks = await collect(provider.complete(req));
    expect(chunks).toEqual([
      { type: "reasoning.delta", text: "Thinking about Paris." },
      { type: "text.delta", text: "Hello" },
      { type: "text.delta", text: " world" },
      { type: "tool_call.delta", index: 0, id: "call_1", name: "get_weather", arguments_delta: '{"ci' },
      { type: "tool_call.delta", index: 0, arguments_delta: 'ty":"Paris"}' },
      { type: "usage", usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } },
      { type: "done", finish_reason: "tool_calls" },
    ]);

    // Verify the outbound request mapping the server received.
    const sent = JSON.parse(bodies.find((b) => b.url === "/v1/chat/completions")?.body ?? "{}");
    expect(sent.model).toBe("local-model-a");
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(sent.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ]);
    expect(sent.messages).toEqual([
      { role: "system", content: "You are terse." },
      {
        role: "user",
        content: [
          { type: "text", text: "Weather in Paris?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "20C sunny" },
    ]);
  });

  it("accepts a local base URL verbatim and derives models from GET /models", async () => {
    handler = (req, res) => {
      expect(req.url).toBe("/v1/models");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "local-model-a", object: "model", created: 1, owned_by: "test" },
          ],
        }),
      );
    };
    const provider = new OpenAICompatibleProvider({ id: "local", baseUrl });
    const models = await provider.listModels();
    expect(models).toEqual([
      { id: "local-model-a", context_window: 8192, max_output: 4096, supports: [] },
    ]);
  });

  it("returns declared models without a network round trip", async () => {
    handler = () => {
      throw new Error("listModels with declared models must not hit the network");
    };
    const declared = [
      { id: "declared-1", context_window: 128000, max_output: 8192, supports: ["tools" as const, "streaming_tools" as const] },
    ];
    const provider = new OpenAICompatibleProvider({ id: "local", baseUrl, models: declared });
    expect(await provider.listModels()).toEqual(declared);
  });

  it("constructs against an arbitrary private-network base URL without contacting it", () => {
    const provider = new OpenAICompatibleProvider({ id: "lan", baseUrl: "http://10.1.2.3:9999/v1" });
    expect(provider.id).toBe("lan");
  });

  it("accepts the literal llama.cpp-style URL http://127.0.0.1:8080/v1 verbatim", async (ctx) => {
    // Bind the canonical local port; skip gracefully if the machine has it busy.
    const server8080 = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "llama-model", object: "model", created: 1, owned_by: "test" },
          ],
        }),
      );
    });
    const listening = await new Promise<boolean>((resolve) => {
      server8080.once("error", () => resolve(false));
      server8080.listen(8080, "127.0.0.1", () => resolve(true));
    });
    if (!listening) {
      ctx.skip();
      return;
    }
    try {
      const provider = new OpenAICompatibleProvider({ id: "llamacpp", baseUrl: "http://127.0.0.1:8080/v1" });
      const models = await provider.listModels();
      expect(models).toEqual([
        { id: "llama-model", context_window: 8192, max_output: 4096, supports: [] },
      ]);
    } finally {
      await new Promise<void>((resolve) => server8080.close(() => resolve()));
    }
  });

  it("classifies 429 responses as rate_limit retryable", async () => {
    handler = (_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error" } }));
    };
    const provider = new OpenAICompatibleProvider({ id: "local", baseUrl });
    const err = await collect(provider.complete({ model: "m", messages: testMessages })).then(
      () => undefined,
      (e: unknown) => e,
    );
    const ser = toSafeSerializedError(err);
    expect(ser.code).toBe("rate_limit");
    expect(ser.retryable).toBe(true);
  });

  it("redacts key material leaked into an error body", async () => {
    handler = (_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "upstream rejected key sk-abcdefgh12345678 for tenant x", type: "server_error" },
        }),
      );
    };
    const provider = new OpenAICompatibleProvider({ id: "local", baseUrl });
    const err = await collect(provider.complete({ model: "m", messages: testMessages })).then(
      () => undefined,
      (e: unknown) => e,
    );
    const ser = toSafeSerializedError(err);
    expect(ser.code).toBe("server_error");
    expect(ser.retryable).toBe(true);
    expect(ser.message).not.toContain("sk-abcdefgh12345678");
    expect(ser.message).toContain("sk-[redacted]");
  });

  it("retries once without optional fields when a server 400s on them, and remembers", async () => {
    const seen: Array<Record<string, unknown>> = [];
    handler = (req, res, body) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      seen.push(parsed);
      if (parsed.reasoning_effort !== undefined || parsed.stream_options !== undefined) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unrecognized request argument supplied: reasoning_effort", type: "invalid_request_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, { ...baseChunk, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] });
      sse(res, { ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
    };
    const provider = new OpenAICompatibleProvider({ id: "local", baseUrl });
    const chunks = await collect(
      provider.complete({
        model: "local-model-a",
        messages: testMessages,
        reasoning_effort: "high",
      }),
    );
    expect(chunks).toEqual([
      { type: "text.delta", text: "ok" },
      { type: "done", finish_reason: "stop" },
    ]);
    expect(seen.length).toBe(2);
    expect(seen[0]?.reasoning_effort).toBe("high");
    expect(seen[1]?.reasoning_effort).toBeUndefined();
    expect(seen[1]?.stream_options).toBeUndefined();

    // The instance remembered: a second call skips optional fields entirely.
    seen.length = 0;
    await collect(provider.complete({ model: "local-model-a", messages: testMessages }));
    expect(seen.length).toBe(1);
    expect(seen[0]?.reasoning_effort).toBeUndefined();
    expect(seen[0]?.stream_options).toBeUndefined();
  });

  it("ends iteration with an aborted error when the signal fires mid-stream", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const timer = setInterval(() => {
        i += 1;
        if (i > 10) {
          clearInterval(timer);
          res.end();
          return;
        }
        sse(res, { ...baseChunk, choices: [{ index: 0, delta: { content: `t${i} ` }, finish_reason: null }] });
      }, 20);
    };
    const provider = new OpenAICompatibleProvider({ id: "local", baseUrl });
    const controller = new AbortController();
    const chunks: ModelChunk[] = [];
    const err = await (async () => {
      try {
        for await (const chunk of provider.complete({
          model: "m",
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
  });
});
