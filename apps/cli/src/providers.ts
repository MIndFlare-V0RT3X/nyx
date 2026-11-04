// SPDX-License-Identifier: AGPL-3.0-or-later
// Config → ModelProvider wiring (local mirror of apps/server/src/providers.ts;
// the CLI may not import @nyx/server). The mock provider gets a small adapter
// so a single config entry serves unlimited turns (a raw MockProvider with a
// fixed script would exhaust after one complete()); openai/anthropic entries
// map to the real providers, with api_key_env resolved from the environment
// at construction time — never from the config file itself.

import type { NyxConfig } from "@nyx/config";
import type {
  CompletionRequest,
  Logger,
  ModelChunk,
  ModelInfo,
  ModelProvider,
} from "@nyx/protocol";
import {
  AnthropicProvider,
  MockProvider,
  mockTextTurn,
  OpenAICompatibleProvider,
} from "@nyx/model";

/** What the built-in mock provider answers on every turn. */
export const MOCK_PROVIDER_MESSAGE =
  "mock provider active — configure real providers in nyx.config.yaml";

/** Typed error for config-derived provider wiring failures. */
export class ProviderConfigError extends Error {
  readonly code = "validation_failed" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/**
 * A `kind: mock` config provider that never runs out: every complete() call
 * runs against a FRESH one-turn script, so the same provider id serves
 * unlimited turns (chat, tool rounds, compaction probes).
 */
export class ReusableMockProvider implements ModelProvider {
  readonly id: string;
  private readonly text: string;

  constructor(id: string, text: string = MOCK_PROVIDER_MESSAGE) {
    this.id = id;
    this.text = text;
  }

  listModels(): Promise<ModelInfo[]> {
    return new MockProvider(this.id, []).listModels();
  }

  async *complete(req: CompletionRequest): AsyncGenerator<ModelChunk, void, void> {
    const turn = new MockProvider(this.id, [mockTextTurn(this.text)]);
    yield* turn.complete(req);
  }
}

/**
 * Build one provider per entry of config.providers, in configuration order.
 * `api_key_env` names an environment variable; a configured-but-missing
 * variable is a hard startup error naming the provider and the variable.
 */
export function buildProviders(
  config: NyxConfig,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): ModelProvider[] {
  const providers: ModelProvider[] = [];
  for (const [id, entry] of Object.entries(config.providers)) {
    if (entry.kind === "mock") {
      providers.push(new ReusableMockProvider(id));
      continue;
    }
    if (entry.kind === "openai") {
      providers.push(
        new OpenAICompatibleProvider({
          id,
          baseUrl: entry.base_url,
          ...(entry.api_key_env !== undefined
            ? { apiKey: requiredEnv(env, entry.api_key_env, id) }
            : {}),
          models: entry.models,
          logger: logger.child({ component: "provider", provider: id }),
        }),
      );
      continue;
    }
    providers.push(
      new AnthropicProvider({
        id,
        apiKey: requiredEnv(env, entry.api_key_env, id),
        models: entry.models,
        ...(entry.base_url !== undefined ? { baseUrl: entry.base_url } : {}),
        logger: logger.child({ component: "provider", provider: id }),
      }),
    );
  }
  return providers;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string, providerId: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new ProviderConfigError(
      `provider "${providerId}": environment variable "${name}" (api_key_env) is not set`,
    );
  }
  return value;
}
