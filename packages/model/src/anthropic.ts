// SPDX-License-Identifier: AGPL-3.0-or-later
// Anthropic Messages API provider (streaming). Maps the protocol's Message /
// ModelChunk shapes to and from Anthropic's format; failures are classified
// by the same shared classifier as the OpenAI-compatible provider.

import Anthropic from "@anthropic-ai/sdk";
import type {
  CompletionRequest,
  Logger,
  Message,
  ModelChunk,
  ModelInfo,
  ModelProvider,
  ToolOutput,
  ToolSchema,
} from "@nyx/protocol";
import { ProviderError, toProviderError } from "./errors.js";

export interface AnthropicProviderOptions {
  /** Registry id for this provider instance. */
  id: string;
  apiKey: string;
  /** Declared model metadata (listModels returns these verbatim). */
  models: ModelInfo[];
  /** Optional override of the API base URL (proxies / gateways). */
  baseUrl?: string;
  logger?: Logger;
}

/** Default max_tokens — Anthropic requires the field; the protocol does not. */
const DEFAULT_MAX_TOKENS = 8192;

function toolOutputToText(output: ToolOutput): string {
  switch (output.kind) {
    case "text":
      return output.text;
    case "json":
      return JSON.stringify(output.json);
    case "file":
      return `[file ${output.path} — ${output.bytes} bytes, ${output.mime}]`;
    case "artifact":
      return `[artifact ${output.artifact_id}: ${output.path} (${output.bytes} bytes)]`;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface AnthropicMappedConversation {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
}

/**
 * Map protocol Messages to Anthropic format: system text blocks are joined
 * into the top-level `system` param; user/assistant text and image blocks map
 * to content blocks; tool_use maps to tool_use content; tool_result maps to
 * tool_result content inside a user message. Reasoning blocks are dropped —
 * they were model-private. Consecutive same-role messages are merged because
 * Anthropic expects strictly alternating roles.
 */
export function toAnthropicConversation(messages: Message[]): AnthropicMappedConversation {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      for (const block of msg.content) {
        if (block.type === "text") systemParts.push(block.text);
      }
      continue;
    }
    const content: Anthropic.ContentBlockParam[] = [];
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          content.push({ type: "text", text: block.text });
          break;
        case "image":
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: block.mime as "image/png",
              data: block.data_base64,
            },
          });
          break;
        case "tool_use":
          content.push({
            type: "tool_use",
            id: block.call_id,
            name: block.name,
            input: block.input ?? {},
          });
          break;
        case "tool_result":
          content.push({
            type: "tool_result",
            tool_use_id: block.call_id,
            content: toolOutputToText(block.output),
          });
          break;
        case "reasoning":
          break; // model-private, never sent back
      }
    }
    if (content.length === 0) continue;
    const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
    const last = out[out.length - 1];
    if (last !== undefined && last.role === role) {
      last.content = [...(last.content as Anthropic.ContentBlockParam[]), ...content];
    } else {
      out.push({ role, content });
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

function toAnthropicTools(tools: ToolSchema[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // Anthropic requires the literal "object" for input_schema.type; tool
    // schemas in this runtime are always object schemas.
    input_schema: { ...t.input_schema, type: "object" } as Anthropic.Tool.InputSchema,
  }));
}

function mapStopReason(reason: string | null | undefined): "stop" | "tool_calls" | "length" {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return "stop";
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  private readonly client: Anthropic;
  private readonly declaredModels: ModelInfo[];
  private readonly logger: Logger | undefined;

  constructor(opts: AnthropicProviderOptions) {
    this.id = opts.id;
    this.declaredModels = [...opts.models];
    this.logger = opts.logger;
    if (typeof opts.apiKey !== "string" || opts.apiKey.length === 0) {
      throw new ProviderError("AnthropicProvider requires an apiKey", {
        code: "provider_error",
        retryable: false,
      });
    }
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: 0, // retry/fallback policy belongs to the router, not the SDK
      ...(opts.baseUrl !== undefined ? { baseURL: opts.baseUrl } : {}),
    });
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([...this.declaredModels]);
  }

  async *complete(req: CompletionRequest): AsyncGenerator<ModelChunk, void, void> {
    const { system, messages } = toAnthropicConversation(req.messages);
    // tool_choice "none" is expressed by not offering tools at all.
    const offerTools = req.tools !== undefined && req.tools.length > 0 && req.tool_choice !== "none";
    const params: Anthropic.MessageStreamParams = {
      model: req.model,
      messages,
      max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      ...(system !== undefined ? { system } : {}),
      ...(offerTools
        ? {
            tools: toAnthropicTools(req.tools ?? []),
            ...(req.tool_choice !== undefined && req.tool_choice !== "none"
              ? {
                  tool_choice:
                    typeof req.tool_choice === "string"
                  ? ({ type: "auto" } as const)
                  : ({ type: "tool", name: req.tool_choice.name } as const),
              }
            : {}),
          }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    this.logger?.debug("anthropic.request", { provider: this.id, model: req.model });

    let stream: ReturnType<typeof this.client.messages.stream>;
    try {
      stream = this.client.messages.stream(params, { signal: req.signal });
    } catch (err) {
      throw toProviderError(err);
    }
    let inputTokens = 0;
    let finish: "stop" | "tool_calls" | "length" = "stop";
    try {
      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            inputTokens = event.message.usage.input_tokens ?? 0;
            break;
          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              yield {
                type: "tool_call.delta",
                index: event.index,
                id: event.content_block.id,
                name: event.content_block.name,
              };
            }
            break;
          case "content_block_delta": {
            // The 0.36.x SDK types predate thinking deltas; read the delta
            // shape defensively so reasoning streams still map.
            const delta = asRecord(event.delta);
            const kind = typeof delta.type === "string" ? delta.type : "";
            if (kind === "text_delta") {
              const text = nonEmptyString(delta.text);
              if (text !== undefined) yield { type: "text.delta", text };
            } else if (kind === "input_json_delta") {
              const json = nonEmptyString(delta.partial_json);
              if (json !== undefined) {
                yield { type: "tool_call.delta", index: event.index, arguments_delta: json };
              }
            } else if (kind === "thinking_delta") {
              const thinking = nonEmptyString(delta.thinking);
              if (thinking !== undefined) yield { type: "reasoning.delta", text: thinking };
            }
            break;
          }
          case "message_delta": {
            const outputTokens = event.usage.output_tokens ?? 0;
            yield {
              type: "usage",
              usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              },
            };
            finish = mapStopReason(event.delta.stop_reason);
            break;
          }
          case "message_stop":
            break;
        }
      }
    } catch (err) {
      throw toProviderError(err);
    }
    if (req.signal?.aborted) {
      throw new ProviderError("request aborted", { code: "aborted", retryable: false });
    }
    // done is always the final chunk, after any usage chunk.
    yield { type: "done", finish_reason: finish };
  }
}
