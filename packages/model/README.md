# @nyx/model

Provider-neutral model access for NYX: streaming `ModelProvider` implementations
(OpenAI-compatible HTTP endpoints and Anthropic), a registry, an ordered-fallback
router with token budgets, and the secret-redaction layer every error surface
passes through. Everything speaks the frozen `@nyx/protocol` shapes
(`CompletionRequest` in, async iterable of `ModelChunk` out).

## Design stance: provider neutrality

Any OpenAI-compatible base URL registers the same way. Local and self-hosted
servers — llama.cpp, LM Studio, vLLM, Ollama — are first-class citizens: pass
`baseUrl` (e.g. `http://127.0.0.1:8080/v1`), omit `apiKey` if the server has
none, and declare model metadata yourself (or let `listModels()` derive it from
`GET /models` with conservative defaults). There is **no host allowlist and no
URL restriction of any kind** in this package; deciding which endpoints to
configure is the operator's job, enforced elsewhere (policy/config), not here.

**Intentionally absent:** refusal detection, refusal retry, and persona-drift
machinery of any kind. This package moves tokens; it does not judge them.
Interpreting model output is the agent layer's concern.

## Public exports

```ts
// redaction (pure)
redactSecrets(value: unknown): unknown                    // deep-clone, "[redacted]" sensitive keys
scrubSecretText(text: string): string                     // sk-… → sk-[redacted], "key":"value" pairs
toSafeSerializedError(err: unknown): SerializedError      // protocol toSerializedError + scrub

// typed provider errors + classification (shared by both SDK providers)
class ProviderError extends Error { code: string; retryable: boolean }
classifyProviderError(err: unknown): SerializedError      // 429→rate_limit, 5xx→server_error,
                                                          // 401/403→auth, timeouts→timeout,
                                                          // aborts→aborted, else provider_error
toProviderError(err: unknown): ProviderError

// scripted provider (tests / offline dev)
class MockProvider implements ModelProvider
mockTextTurn(text: string): ModelChunk[]
mockToolTurn(call: { call_id; name; input }): ModelChunk[]
mockTextAndToolTurn(text, call): ModelChunk[]
mockFailTurn(err: unknown): { fail: SerializedError }
type MockTurn = ModelChunk[] | { fail: SerializedError }

// OpenAI-compatible (hosted or local: llama.cpp, LM Studio, vLLM, Ollama, …)
class OpenAICompatibleProvider implements ModelProvider
new OpenAICompatibleProvider({ id, baseUrl, apiKey?, models?, logger? })
toOpenAIMessages(messages: Message[]): OpenAI chat message params   // exported for inspection

// Anthropic Messages API (streaming)
class AnthropicProvider implements ModelProvider
new AnthropicProvider({ id, apiKey, models, baseUrl?, logger? })
toAnthropicConversation(messages: Message[]): { system, messages }  // exported for inspection

// registry (no allowlist, no restrictions)
class ProviderRegistryImpl implements ProviderRegistry   // register / get / list

// ordered-fallback router
class ModelRouterImpl implements ModelRouter
new ModelRouterImpl(registry, config: RouterConfig, logger?, budgets?)
interface ChainStep   { provider; model; reasoning_effort?; max_tokens?; tool_choice? }
interface RouteRule   { task; chain; fallback_on? }
interface RouterConfig{ default: { chain; fallback_on? }; rules?: RouteRule[] }
interface RouterBudgets{ per_turn_tokens; per_session_tokens; on_exceed }
type FallbackCode = "rate_limit" | "server_error" | "timeout"
```

`RouterConfig` is defined here on purpose so `@nyx/config` can structurally
match it without importing this package (no dependency cycle).

## Usage

```ts
import { ModelRouterImpl, OpenAICompatibleProvider, ProviderRegistryImpl } from "@nyx/model";

const registry = new ProviderRegistryImpl();
registry.register(
  new OpenAICompatibleProvider({
    id: "local-llamacpp",
    baseUrl: "http://127.0.0.1:8080/v1", // any endpoint, verbatim
    models: [{ id: "qwen3-8b", context_window: 131072, max_output: 8192, supports: ["tools"] }],
  }),
);
registry.register(
  new OpenAICompatibleProvider({
    id: "hosted",
    baseUrl: "https://api.example.com/v1",
    apiKey: process.env["EXAMPLE_API_KEY"], // env var *name* resolved by config
    models: [
      { id: "glm-4.7", context_window: 131072, max_output: 8192, supports: ["tools", "reasoning"] },
    ],
  }),
);

const router = new ModelRouterImpl(
  registry,
  {
    default: { chain: [{ provider: "hosted", model: "glm-4.7" }] },
    rules: [
      {
        task: "compaction",
        chain: [
          { provider: "local-llamacpp", model: "qwen3-8b", max_tokens: 2048 },
          { provider: "hosted", model: "glm-4.7" },
        ],
      },
    ],
  },
  logger,
  { per_turn_tokens: 32768, per_session_tokens: 2_000_000, on_exceed: "ask" },
);

for await (const chunk of router.complete(
  { model: "-", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
  { task: "compaction" },
)) {
  // text.delta | reasoning.delta | tool_call.delta | usage | done
}
```

## Design notes / invariants

- **Streaming, lazy, cancel-safe.** `complete()` is an async generator: nothing
  touches the network until first iteration, and abandoning the iterator
  (break/return) aborts the underlying request.
- **`done` is always the final chunk** a consumer sees on success — usage
  chunks (which OpenAI servers deliver _after_ the finish_reason) are yielded
  first. Mid-stream user aborts surface as a thrown error with code
  `"aborted"` from both providers (the OpenAI SDK would otherwise end
  silently; this is normalized).
- **Errors are typed and redacted.** Every failure crosses
  `classifyProviderError` → `ProviderError` with a stable `code` +
  `retryable` flag. Messages/stacks are scrubbed (`sk-…` tokens, inline
  `"api_key": "…"` pairs) and structured values under sensitive-looking keys
  are replaced with `[redacted]`. The dummy `"not-set"` key used to satisfy
  the OpenAI SDK constructor for keyless local servers never appears in any
  error. SDK-level retries are disabled (`maxRetries: 0`); retry/fallback
  policy belongs to the router.
- **Optional-field tolerance.** Some strict OpenAI-compatible servers reject
  `reasoning_effort` / `stream_options` with a 400. The provider retries once
  without them and remembers per-instance.
- **Reasoning conventions.** Inbound: `reasoning_content` (GLM/DeepSeek) and
  `reasoning` (llama.cpp) map to `reasoning.delta`; Anthropic `thinking_delta`
  likewise. Outbound: reasoning blocks are never sent back to a model.
- **Fallback semantics.** The router falls to the next step only when the
  error is `retryable` AND its code is in the chain's `fallback_on` (default:
  rate_limit, server_error, timeout). Non-retryable errors rethrow
  immediately. Chunks already yielded before a mid-stream failure are not
  unsent — streaming fallback means the consumer may see partial output from
  the failed step followed by the next step's output. Missing providers are
  skipped with a `route.fallback` warn.
- **Budgets.** `recordUsage` accumulates per session; `checkBudget` compares
  the session total against `per_session_tokens`. **Per-turn budget
  enforcement is the agent's job** — the router only answers queries.
- **listModels.** OpenAI-compatible: declared models win; otherwise one
  `ModelInfo` per remote id with conservative defaults (context 8192, no tool
  support); any failure → `provider_error`. Anthropic: declared models
  verbatim. Router: union of all providers via `allSettled`, failing
  providers skipped with a warn.
- **Message mapping.** Images become `image_url` data URLs (OpenAI) / base64
  sources (Anthropic); `tool_result` blocks become `role:"tool"` messages
  (OpenAI) / `tool_result` user content (Anthropic); system text is joined
  into Anthropic's top-level `system`. Anthropic requires alternating roles,
  so consecutive same-role messages are merged.

## Intentionally deferred

- Refusal detection / refusal retry / persona-drift machinery — out of scope
  by design (and not planned for this layer).
- Provider-level retry with backoff (router fallback only), request
  queuing, batching, prompt caching hints, fine-grained per-model rate
  limits.
- Anthropic extended-thinking request params (`thinking` budgets) — inbound
  thinking deltas are mapped, outbound effort→budget conversion is not.
- `response_format` JSON-schema enforcement on the Anthropic provider (no
  equivalent in the pinned SDK); `metadata` is not forwarded to either API.
- Streaming tool-call _reassembly_ (index/keyed accumulation of
  `tool_call.delta` fragments) — consumers (the agent) assemble.
