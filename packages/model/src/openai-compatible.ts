// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenAI-compatible chat-completions provider. Deliberately provider-
// neutral: any base URL — hosted or self-hosted (llama.cpp, LM Studio, vLLM,
// Ollama, ...) — registers exactly the same way. There is no host allowlist
// and no URL restriction of any kind.

import OpenAI from "openai";
import type {
  Logger,
  Message,
  ModelChunk,
  ModelInfo,
  ModelProvider,
  CompletionRequest,
  ToolOutput,
  ToolSchema,
  Usage,
} from "@nyx/protocol";
import { ProviderError, toProviderError } from "./errors.js";
import { toSafeSerializedError } from "./redact.js";

export { classifyProviderError } from "./errors.js";

export interface OpenAICompatibleProviderOptions {
  /** Registry id for this provider instance. */
  id: string;
  /**
   * Base URL of any OpenAI-compatible endpoint, used verbatim — e.g.
   * "http://127.0.0.1:8080/v1" for a local llama.cpp server.
   */
  baseUrl: string;
  /** Optional API key. Local servers usually need none. */
  apiKey?: string;
  /** Declared model metadata; when empty, listModels() derives entries from GET /models. */
  models?: ModelInfo[];
  logger?: Logger;
}

type OpenAIMessages = OpenAI.Chat.Completions.ChatCompletionMessageParam[];
type OpenAIToolMessage = OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
type OpenAIAssistantMessage = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;

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

/**
 * Map protocol Messages to OpenAI chat format:
 * - system text blocks → system message (joined)
 * - user text blocks → content string; image blocks → image_url data-URL parts
 * - assistant tool_use blocks → assistant `tool_calls` (arguments as JSON string)
 * - tool_result blocks → `role:"tool"` messages with tool_call_id
 * - reasoning blocks are dropped: they were model-private
 */
export function toOpenAIMessages(messages: Message[]): OpenAIMessages {
  const out: OpenAIMessages = [];
  for (const msg of messages) {
    const textParts: string[] = [];
    const imageParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    const toolCalls: NonNullable<OpenAIAssistantMessage["tool_calls"]> = [];
    const toolResults: OpenAIToolMessage[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          textParts.push(block.text);
          imageParts.push({ type: "text", text: block.text });
          break;
        case "image":
          imageParts.push({
            type: "image_url",
            image_url: { url: `data:${block.mime};base64,${block.data_base64}` },
          });
          break;
        case "tool_use":
          toolCalls.push({
            id: block.call_id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
          break;
        case "tool_result":
          toolResults.push({
            role: "tool",
            tool_call_id: block.call_id,
            content: toolOutputToText(block.output),
          });
          break;
        case "reasoning":
          break; // model-private, never sent back
      }
    }

    out.push(...toolResults);

    if (msg.role === "system") {
      out.push({ role: "system", content: textParts.join("\n\n") });
    } else if (msg.role === "assistant") {
      if (textParts.length > 0 || toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("") : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
    } else {
      // user, or a "tool"-role message whose text blocks had no tool_result
      if (imageParts.length > 0) {
        out.push({ role: "user", content: imageParts });
      } else if (textParts.length > 0) {
        out.push({ role: "user", content: textParts.join("") });
      } else if (msg.role === "user" && msg.content.length === 0) {
        out.push({ role: "user", content: "" });
      }
    }
  }
  return out;
}

function toOpenAITools(tools: ToolSchema[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function toOpenAIToolChoice(
  choice: NonNullable<CompletionRequest["tool_choice"]>,
): OpenAI.Chat.Completions.ChatCompletionToolChoiceOption {
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

function mapFinishReason(reason: string): "stop" | "tool_calls" | "length" {
  if (reason === "tool_calls") return "tool_calls";
  if (reason === "length") return "length";
  return "stop";
}

function mapUsage(u: NonNullable<OpenAI.Chat.Completions.ChatCompletionChunk["usage"]>): Usage {
  const input = u.prompt_tokens ?? 0;
  const output = u.completion_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    ...(reasoning > 0 ? { reasoning_tokens: reasoning } : {}),
    ...(cached > 0 ? { cache_read_tokens: cached } : {}),
    total_tokens: u.total_tokens ?? input + output + reasoning,
  };
}

/** Read a non-empty extra string field the official SDK types don't declare. */
function extraString(source: object, key: string): string | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isBadRequest(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; status?: unknown };
  return e.name === "BadRequestError" || e.status === 400;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly client: OpenAI;
  private readonly declaredModels: ModelInfo[] | undefined;
  private readonly logger: Logger | undefined;
  /**
   * Set when a server 400'd on optional request fields; from then on this
   * instance never sends them again (reasoning_effort, stream_options).
   */
  private omitOptionalFields = false;

  constructor(opts: OpenAICompatibleProviderOptions) {
    this.id = opts.id;
    this.declaredModels = opts.models;
    this.logger = opts.logger;
    // The SDK refuses to construct without a key; local servers have none.
    // The dummy value is only ever sent as a bearer token to the configured
    // base URL and is scrubbed from every error surface.
    this.client = new OpenAI({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey ?? "not-set",
      maxRetries: 0, // retry/fallback policy belongs to the router, not the SDK
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.declaredModels && this.declaredModels.length > 0) {
      return [...this.declaredModels];
    }
    try {
      const page = await this.client.models.list();
      const ids = page.data
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string");
      // Conservative defaults for unknown remote models.
      return ids.map((id) => ({
        id,
        context_window: 8192,
        max_output: 4096,
        supports: [],
      }));
    } catch (err) {
      const safe = toSafeSerializedError(err);
      throw new ProviderError(safe.message, {
        code: "provider_error",
        retryable: false,
        name: safe.name,
        cause: err,
      });
    }
  }

  async *complete(req: CompletionRequest): AsyncGenerator<ModelChunk, void, void> {
    yield* this.stream(req, !this.omitOptionalFields);
  }

  private async *stream(
    req: CompletionRequest,
    withOptionalFields: boolean,
  ): AsyncGenerator<ModelChunk, void, void> {
    const body = this.buildBody(req, withOptionalFields);
    let chunks: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      chunks = await this.client.chat.completions.create(body, { signal: req.signal });
    } catch (err) {
      if (withOptionalFields && isBadRequest(err)) {
        // Server rejected an extra field (reasoning_effort /
        // stream_options). Retry once without optional fields and remember.
        this.omitOptionalFields = true;
        this.logger?.warn("provider.drop_optional_fields", {
          provider: this.id,
          model: req.model,
        });
        yield* this.stream(req, false);
        return;
      }
      throw toProviderError(err);
    }

    let finish: "stop" | "tool_calls" | "length" = "stop";
    try {
      for await (const chunk of chunks) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta) {
          // Reasoning conventions: reasoning_content (GLM/DeepSeek),
          // reasoning (llama.cpp). Emit whichever is present and non-empty.
          const reasoning =
            extraString(delta, "reasoning_content") ?? extraString(delta, "reasoning");
          if (reasoning !== undefined) {
            yield { type: "reasoning.delta", text: reasoning };
          }
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "text.delta", text: delta.content };
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              yield {
                type: "tool_call.delta",
                index: tc.index,
                ...(tc.id !== undefined ? { id: tc.id } : {}),
                ...(tc.function?.name ? { name: tc.function.name } : {}),
                ...(tc.function?.arguments ? { arguments_delta: tc.function.arguments } : {}),
              };
            }
          }
        }
        if (chunk.usage) {
          yield { type: "usage", usage: mapUsage(chunk.usage) };
        }
        if (choice?.finish_reason) {
          finish = mapFinishReason(choice.finish_reason);
        }
      }
    } catch (err) {
      throw toProviderError(err);
    }
    // The openai SDK ends iteration silently on user abort; normalize to the
    // same "aborted" failure every other code path produces.
    if (req.signal?.aborted) {
      throw new ProviderError("request aborted", { code: "aborted", retryable: false });
    }
    // done is always the final chunk, after any trailing usage chunk.
    yield { type: "done", finish_reason: finish };
  }

  private buildBody(
    req: CompletionRequest,
    withOptionalFields: boolean,
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
      model: req.model,
      messages: toOpenAIMessages(req.messages),
      stream: true,
      ...(withOptionalFields ? { stream_options: { include_usage: true } } : {}),
      ...(req.tools && req.tools.length > 0 ? { tools: toOpenAITools(req.tools) } : {}),
      ...(req.tool_choice !== undefined
        ? { tool_choice: toOpenAIToolChoice(req.tool_choice) }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
      ...(req.response_format !== undefined
        ? {
            response_format: {
              type: "json_schema" as const,
              json_schema: {
                name: req.response_format.name,
                schema: req.response_format.schema,
              },
            },
          }
        : {}),
    };
    if (withOptionalFields && req.reasoning_effort !== undefined) {
      // Providers disagree on the enum (OpenAI: low|medium|high; others allow
      // "max"); the configured value is passed through verbatim.
      (body as { reasoning_effort?: string }).reasoning_effort = req.reasoning_effort;
    }
    return body;
  }
}
