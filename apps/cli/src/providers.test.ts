// SPDX-License-Identifier: AGPL-3.0-or-later
// Provider wiring: the reusable mock adapter never exhausts, config mock
// entries map to it, and hosted entries resolve api_key_env from the env (a
// configured-but-missing variable is a typed startup error).

import { describe, expect, it } from "vitest";
import type { Logger, ModelChunk } from "@nyx/protocol";
import { configSchema, type NyxConfig } from "@nyx/config";
import { mockTextTurn, mockToolTurn } from "@nyx/model";
import {
  buildProviders,
  MOCK_PROVIDER_MESSAGE,
  ProviderConfigError,
  ReusableMockProvider,
} from "./providers.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

function parseConfig(providers: Record<string, unknown>): NyxConfig {
  return configSchema.parse({
    providers,
    router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
  });
}

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const req = { model: "mock-1", messages: [] };

describe("ReusableMockProvider", () => {
  it("serves unlimited turns (a fresh one-turn script per complete)", async () => {
    const provider = new ReusableMockProvider("mock");
    for (let i = 0; i < 5; i++) {
      const chunks = await collect(provider.complete(req));
      const text = chunks
        .filter((c) => c.type === "text.delta")
        .map((c) => (c.type === "text.delta" ? c.text : ""))
        .join("");
      expect(text).toBe(MOCK_PROVIDER_MESSAGE);
    }
  });

  it("declares the standard mock model", async () => {
    const models = await new ReusableMockProvider("mock").listModels();
    expect(models.map((m) => m.id)).toEqual(["mock-1"]);
  });
});

describe("buildProviders", () => {
  it("maps a mock config entry to the reusable adapter", () => {
    const providers = buildProviders(parseConfig({ mock: { kind: "mock" } }), silentLogger);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toBeInstanceOf(ReusableMockProvider);
  });

  it("resolves api_key_env from the env at construction time", () => {
    const config = parseConfig({
      hosted: {
        kind: "openai",
        base_url: "http://127.0.0.1:9/v1",
        api_key_env: "NYX_TEST_KEY",
        models: [{ id: "m", context_window: 8, max_output: 8, supports: [] }],
      },
    });
    const providers = buildProviders(config, silentLogger, { NYX_TEST_KEY: "test-value" });
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("hosted");
  });

  it("throws a typed error naming provider and variable when the env is missing", () => {
    const config = parseConfig({
      hosted: {
        kind: "anthropic",
        api_key_env: "NYX_MISSING_KEY",
        models: [{ id: "m", context_window: 8, max_output: 8, supports: [] }],
      },
    });
    expect(() => buildProviders(config, silentLogger, {})).toThrow(ProviderConfigError);
    expect(() => buildProviders(config, silentLogger, {})).toThrow(/NYX_MISSING_KEY/);
  });

  it("a scripted MockProvider still exhausts (contrast for the adapter's purpose)", async () => {
    const { MockProvider } = await import("@nyx/model");
    const scripted = new MockProvider("mock", [
      mockTextTurn("one"),
      mockToolTurn({ call_id: "c1", name: "fs.read", input: { path: "x" } }),
    ]);
    expect((await collect(scripted.complete(req))).length).toBeGreaterThan(0);
    expect((await collect(scripted.complete(req))).length).toBeGreaterThan(0);
    await expect(collect(scripted.complete(req))).rejects.toThrow(/mock script exhausted/);
  });
});
