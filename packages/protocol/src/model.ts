// SPDX-License-Identifier: AGPL-3.0-or-later
// Model provider and router contracts. Provider-neutral by design: any
// OpenAI-compatible endpoint — hosted or self-hosted (llama.cpp, LM Studio,
// vLLM, Ollama, ...) — registers the same way. There is deliberately no
// refusal-detection or refusal-retry machinery in this layer.

import type { Message } from "./content.js";
import type { JsonSchema, Usage } from "./util.js";
import type { ToolSchema } from "./content.js";

export interface ModelInfo {
  id: string;
  context_window: number;
  max_output: number;
  supports: Array<
    "tools" | "vision" | "reasoning" | "reasoning_retained" | "json_schema" | "streaming_tools"
  >;
}

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  tool_choice?: "auto" | "none" | { name: string };
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: "low" | "high" | "max";
  response_format?: { type: "json_schema"; schema: JsonSchema; name: string };
  metadata?: Record<string, string>;
  signal?: AbortSignal;
}

export type ModelChunk =
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool_call.delta"; index: number; id?: string; name?: string; arguments_delta?: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finish_reason: "stop" | "tool_calls" | "length" | "error" };

export interface ModelProvider {
  readonly id: string;
  listModels(): Promise<ModelInfo[]>;
  complete(req: CompletionRequest): AsyncIterable<ModelChunk>;
}

export interface ProviderRegistry {
  register(provider: ModelProvider): void;
  get(id: string): ModelProvider | undefined;
  list(): ModelProvider[];
}

export interface RouteOptions {
  /** Logical task tag used to pick a rule-specific chain, e.g. "compaction". */
  task?: string;
}

export interface BudgetStatus {
  exceeded: boolean;
  used: number;
  limit: number;
  on_exceed: "ask" | "trim" | "abort";
}

/**
 * Ordered-fallback router. Selects a chain for the request, tries providers in
 * order on retryable failures (rate_limit / server_error / timeout), applies
 * per-route overrides, records usage, and answers budget queries.
 */
export interface ModelRouter {
  complete(req: CompletionRequest, opts?: RouteOptions): AsyncIterable<ModelChunk>;
  listModels(): Promise<ModelInfo[]>;
  recordUsage(session_id: string, usage: Usage): void;
  checkBudget(session_id: string): BudgetStatus;
}
