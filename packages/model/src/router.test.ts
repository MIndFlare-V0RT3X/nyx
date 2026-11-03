// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type {
  CompletionRequest,
  Logger,
  ModelChunk,
  ModelInfo,
  ModelProvider,
} from "@nyx/protocol";
import { ProviderRegistryImpl } from "./registry.js";
import { ModelRouterImpl } from "./router.js";

class FakeProvider implements ModelProvider {
  readonly id: string;
  calls = 0;
  readonly requests: CompletionRequest[] = [];
  private readonly behavior: (req: CompletionRequest) => AsyncIterable<ModelChunk>;
  private readonly models: ModelInfo[];

  constructor(
    id: string,
    behavior: (req: CompletionRequest) => AsyncIterable<ModelChunk>,
    models: ModelInfo[] = [],
  ) {
    this.id = id;
    this.behavior = behavior;
    this.models = models;
  }

  listModels(): Promise<ModelInfo[]> {
    if (this.models.length === 0) {
      return Promise.reject(new Error("models unavailable"));
    }
    return Promise.resolve(this.models);
  }

  async *complete(req: CompletionRequest): AsyncGenerator<ModelChunk, void, void> {
    this.calls += 1;
    this.requests.push(req);
    yield* this.behavior(req);
  }
}

async function* textStream(text: string): AsyncGenerator<ModelChunk, void, void> {
  yield { type: "text.delta", text };
  yield { type: "done", finish_reason: "stop" };
}

function throwObject(err: Record<string, unknown>): () => AsyncGenerator<ModelChunk, void, void> {
  // eslint-disable-next-line require-yield -- intentional immediate-throw generator
  return async function* () {
    throw err;
  };
}

interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  ctx?: Record<string, unknown>;
}

function capturingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger: Logger = {
    debug: (msg, ctx) => lines.push({ level: "debug", msg, ctx }),
    info: (msg, ctx) => lines.push({ level: "info", msg, ctx }),
    warn: (msg, ctx) => lines.push({ level: "warn", msg, ctx }),
    error: (msg, ctx) => lines.push({ level: "error", msg, ctx }),
    child: () => logger,
  };
  return { logger, lines };
}

const req: CompletionRequest = {
  model: "whatever",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

async function collect(iter: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

describe("ProviderRegistryImpl", () => {
  it("registers, gets, and lists providers; unknown ids are undefined", () => {
    const registry = new ProviderRegistryImpl();
    const provider = new FakeProvider("p1", () => textStream("ok"));
    registry.register(provider);
    expect(registry.get("p1")).toBe(provider);
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.list()).toEqual([provider]);
  });
});

describe("ModelRouterImpl", () => {
  it("falls back to the second provider on a retryable rate_limit error", async () => {
    const first = new FakeProvider(
      "first",
      throwObject({ name: "ProviderError", message: "slow down", code: "rate_limit", retryable: true }),
    );
    const second = new FakeProvider("second", () => textStream("from second"));
    const registry = new ProviderRegistryImpl();
    registry.register(first);
    registry.register(second);
    const { logger, lines } = capturingLogger();
    const router = new ModelRouterImpl(
      registry,
      { default: { chain: [{ provider: "first", model: "m1" }, { provider: "second", model: "m2" }] } },
      logger,
    );

    const chunks = await collect(router.complete(req));
    expect(chunks).toEqual([
      { type: "text.delta", text: "from second" },
      { type: "done", finish_reason: "stop" },
    ]);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
    expect(second.requests[0]?.model).toBe("m2");

    const selected = lines.filter((l) => l.msg === "route.selected");
    expect(selected).toHaveLength(2);
    expect(selected[0]?.ctx).toMatchObject({ task: "default", provider: "first", model: "m1", attempt: 1 });
    expect(selected[1]?.ctx).toMatchObject({ task: "default", provider: "second", model: "m2", attempt: 2 });
    const fallbacks = lines.filter((l) => l.msg === "route.fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.ctx).toMatchObject({ from: "first", to: "second", code: "rate_limit" });
  });

  it("propagates the error when fallback_on excludes the failure code", async () => {
    const first = new FakeProvider(
      "first",
      throwObject({ name: "ProviderError", message: "slow down", code: "rate_limit", retryable: true }),
    );
    const second = new FakeProvider("second", () => textStream("unused"));
    const registry = new ProviderRegistryImpl();
    registry.register(first);
    registry.register(second);
    const router = new ModelRouterImpl(registry, {
      default: {
        chain: [{ provider: "first", model: "m1" }, { provider: "second", model: "m2" }],
        fallback_on: ["server_error", "timeout"],
      },
    });

    await expect(collect(router.complete(req))).rejects.toMatchObject({
      code: "rate_limit",
      retryable: true,
    });
    expect(second.calls).toBe(0);
  });

  it("rethrows non-retryable auth errors immediately without calling the next provider", async () => {
    const first = new FakeProvider(
      "first",
      throwObject({ name: "ProviderError", message: "bad key", code: "auth", retryable: false }),
    );
    const second = new FakeProvider("second", () => textStream("unused"));
    const registry = new ProviderRegistryImpl();
    registry.register(first);
    registry.register(second);
    const router = new ModelRouterImpl(registry, {
      default: { chain: [{ provider: "first", model: "m1" }, { provider: "second", model: "m2" }] },
    });

    await expect(collect(router.complete(req))).rejects.toMatchObject({ code: "auth" });
    expect(second.calls).toBe(0);
  });

  it("throws the last error when every step in the chain fails", async () => {
    const first = new FakeProvider(
      "first",
      throwObject({ name: "E", message: "one", code: "server_error", retryable: true }),
    );
    const second = new FakeProvider(
      "second",
      throwObject({ name: "E", message: "two", code: "timeout", retryable: true }),
    );
    const registry = new ProviderRegistryImpl();
    registry.register(first);
    registry.register(second);
    const router = new ModelRouterImpl(registry, {
      default: { chain: [{ provider: "first", model: "m1" }, { provider: "second", model: "m2" }] },
    });
    await expect(collect(router.complete(req))).rejects.toMatchObject({ message: "two" });
  });

  it("skips steps whose provider is not registered and continues", async () => {
    const real = new FakeProvider("real", () => textStream("made it"));
    const registry = new ProviderRegistryImpl();
    registry.register(real);
    const { logger, lines } = capturingLogger();
    const router = new ModelRouterImpl(
      registry,
      { default: { chain: [{ provider: "ghost", model: "m0" }, { provider: "real", model: "m1" }] } },
      logger,
    );
    const chunks = await collect(router.complete(req));
    expect(chunks[0]).toEqual({ type: "text.delta", text: "made it" });
    expect(lines.some((l) => l.msg === "route.fallback" && l.ctx?.code === "provider_missing")).toBe(true);
  });

  it("applies step overrides (model, max_tokens, reasoning_effort, tool_choice) to the request", async () => {
    const provider = new FakeProvider("p", () => textStream("ok"));
    const registry = new ProviderRegistryImpl();
    registry.register(provider);
    const router = new ModelRouterImpl(registry, {
      default: {
        chain: [
          {
            provider: "p",
            model: "route-model",
            max_tokens: 77,
            reasoning_effort: "high",
            tool_choice: { name: "search" },
          },
        ],
      },
    });
    await collect(router.complete({ ...req, max_tokens: 10, tool_choice: "auto" }));
    const sent = provider.requests[0];
    expect(sent?.model).toBe("route-model");
    expect(sent?.max_tokens).toBe(77);
    expect(sent?.reasoning_effort).toBe("high");
    expect(sent?.tool_choice).toEqual({ name: "search" });
  });

  it("uses the task-tagged rule when opts.task matches", async () => {
    const compaction = new FakeProvider("compactor", () => textStream("compacted"));
    const registry = new ProviderRegistryImpl();
    registry.register(compaction);
    const router = new ModelRouterImpl(registry, {
      default: { chain: [{ provider: "none-registered", model: "m" }] },
      rules: [{ task: "compaction", chain: [{ provider: "compactor", model: "c-model" }] }],
    });
    const chunks = await collect(router.complete(req, { task: "compaction" }));
    expect(chunks[0]).toEqual({ type: "text.delta", text: "compacted" });
    expect(compaction.requests[0]?.model).toBe("c-model");
  });

  it("unions listModels across providers, skipping failed ones", async () => {
    const ok1 = new FakeProvider("ok1", () => textStream("a"), [
      { id: "a1", context_window: 1, max_output: 1, supports: [] },
    ]);
    const ok2 = new FakeProvider("ok2", () => textStream("b"), [
      { id: "b1", context_window: 2, max_output: 2, supports: [] },
    ]);
    const bad = new FakeProvider("bad", () => textStream("c"));
    const registry = new ProviderRegistryImpl();
    registry.register(ok1);
    registry.register(bad);
    registry.register(ok2);
    const { logger, lines } = capturingLogger();
    const router = new ModelRouterImpl(registry, { default: { chain: [] } }, logger);
    const models = await router.listModels();
    expect(models.map((m) => m.id)).toEqual(["a1", "b1"]);
    expect(lines.some((l) => l.msg === "route.list_models_failed" && l.ctx?.provider === "bad")).toBe(true);
  });

  it("accumulates usage per session and checkBudget flips to exceeded", () => {
    const router = new ModelRouterImpl(new ProviderRegistryImpl(), { default: { chain: [] } }, undefined, {
      per_turn_tokens: 500,
      per_session_tokens: 1000,
      on_exceed: "ask",
    });
    const initial = router.checkBudget("s1");
    expect(initial).toMatchObject({ exceeded: false, used: 0, limit: 1000, on_exceed: "ask" });

    router.recordUsage("s1", { input_tokens: 400, output_tokens: 300 });
    expect(router.checkBudget("s1").used).toBe(700);

    router.recordUsage("s1", { input_tokens: 250, output_tokens: 150 });
    const exceeded = router.checkBudget("s1");
    expect(exceeded.exceeded).toBe(true);
    expect(exceeded.used).toBe(1100);

    // Sessions are independent.
    expect(router.checkBudget("s2").exceeded).toBe(false);
  });

  it("never exceeds an unconfigured budget", () => {
    const router = new ModelRouterImpl(new ProviderRegistryImpl(), { default: { chain: [] } });
    router.recordUsage("s", { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: Number.MAX_SAFE_INTEGER });
    expect(router.checkBudget("s").exceeded).toBe(false);
  });
});
