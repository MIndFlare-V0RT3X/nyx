// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/model — provider-neutral model access: providers, registry, router,
// and the redaction layer every error surface passes through.

export { REDACTED, redactSecrets, scrubSecretText, toSafeSerializedError } from "./redact.js";
export { ProviderError, classifyProviderError, toProviderError } from "./errors.js";
export type { RetryableCode } from "./errors.js";
export {
  MockProvider,
  mockFailTurn,
  mockTextAndToolTurn,
  mockTextTurn,
  mockToolTurn,
} from "./mock.js";
export type { MockProviderOptions, MockTurn } from "./mock.js";
export { OpenAICompatibleProvider, toOpenAIMessages } from "./openai-compatible.js";
export type { OpenAICompatibleProviderOptions } from "./openai-compatible.js";
export { AnthropicProvider, toAnthropicConversation } from "./anthropic.js";
export type { AnthropicProviderOptions } from "./anthropic.js";
export { ProviderRegistryImpl } from "./registry.js";
export { ModelRouterImpl } from "./router.js";
export type { ChainStep, FallbackCode, RouterBudgets, RouterConfig, RouteRule } from "./router.js";
