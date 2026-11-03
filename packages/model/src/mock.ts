// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic scripted provider for tests and offline development. Each
// call to complete() consumes exactly one scripted turn; when the script runs
// out, the provider fails with a typed "mock script exhausted" error.

import type {
  CompletionRequest,
  ModelChunk,
  ModelInfo,
  ModelProvider,
  SerializedError,
  Usage,
} from "@nyx/protocol";
import { ProviderError } from "./errors.js";
import { toSafeSerializedError } from "./redact.js";

/** One scripted turn: the chunks to stream, or a failure to throw. */
export type MockTurn = ModelChunk[] | { fail: SerializedError };

export interface MockProviderOptions {
  /** Declared model list; defaults to a single "mock-1" entry. */
  models?: ModelInfo[];
}

function defaultMockModel(): ModelInfo {
  return {
    id: "mock-1",
    context_window: 128000,
    max_output: 8192,
    supports: ["tools", "streaming_tools"],
  };
}

function estimateUsage(text: string): Usage {
  const output = Math.max(1, Math.ceil(text.length / 4));
  return { input_tokens: 0, output_tokens: output, total_tokens: output };
}

function isFailTurn(turn: MockTurn): turn is { fail: SerializedError } {
  return !Array.isArray(turn);
}

/** Build a failure turn from any thrown value (redacted before scripting). */
export function mockFailTurn(err: unknown): { fail: SerializedError } {
  return { fail: toSafeSerializedError(err) };
}

/**
 * Scripted ModelProvider. `complete()` pops the next turn and yields its
 * chunks (or throws its failure); a call on an exhausted script throws a
 * ProviderError with code "provider_error" and message "mock script
 * exhausted".
 */
export class MockProvider implements ModelProvider {
  readonly id: string;
  private readonly turns: MockTurn[];
  private readonly declaredModels: ModelInfo[] | undefined;

  constructor(id: string, script: MockTurn[], opts: MockProviderOptions = {}) {
    this.id = id;
    this.turns = [...script];
    this.declaredModels = opts.models;
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(this.declaredModels ? [...this.declaredModels] : [defaultMockModel()]);
  }

  async *complete(_req: CompletionRequest): AsyncGenerator<ModelChunk, void, void> {
    const turn = this.turns.shift();
    if (turn === undefined) {
      throw new ProviderError("mock script exhausted", { code: "provider_error", retryable: false });
    }
    if (isFailTurn(turn)) {
      const safe = toSafeSerializedError(turn.fail);
      throw new ProviderError(safe.message, {
        code: safe.code ?? "provider_error",
        retryable: safe.retryable ?? false,
        name: safe.name,
      });
    }
    for (const chunk of turn) {
      yield chunk;
    }
  }
}

/** Script a plain text answer: two text deltas + usage + done(stop). */
export function mockTextTurn(text: string): ModelChunk[] {
  const chunks: ModelChunk[] = [];
  if (text.length > 0) {
    const mid = Math.ceil(text.length / 2);
    chunks.push({ type: "text.delta", text: text.slice(0, mid) });
    chunks.push({ type: "text.delta", text: text.slice(mid) });
  }
  chunks.push({ type: "usage", usage: estimateUsage(text) });
  chunks.push({ type: "done", finish_reason: "stop" });
  return chunks;
}

/**
 * Script a tool call: tool_call.delta with id/name and the JSON arguments
 * split across two fragments + usage + done(tool_calls).
 */
export function mockToolTurn(call: {
  call_id: string;
  name: string;
  input: Record<string, unknown>;
}): ModelChunk[] {
  const args = JSON.stringify(call.input);
  const split = Math.ceil(args.length / 2);
  const chunks: ModelChunk[] = [
    {
      type: "tool_call.delta",
      index: 0,
      id: call.call_id,
      name: call.name,
      arguments_delta: args.slice(0, split),
    },
    { type: "tool_call.delta", index: 0, arguments_delta: args.slice(split) },
    { type: "usage", usage: estimateUsage("") },
    { type: "done", finish_reason: "tool_calls" },
  ];
  return chunks;
}

/** Script a text answer followed by a tool call in the same turn. */
export function mockTextAndToolTurn(
  text: string,
  call: { call_id: string; name: string; input: Record<string, unknown> },
): ModelChunk[] {
  const chunks: ModelChunk[] = [];
  if (text.length > 0) {
    const mid = Math.ceil(text.length / 2);
    chunks.push({ type: "text.delta", text: text.slice(0, mid) });
    chunks.push({ type: "text.delta", text: text.slice(mid) });
  }
  const args = JSON.stringify(call.input);
  const split = Math.ceil(args.length / 2);
  chunks.push(
    {
      type: "tool_call.delta",
      index: 0,
      id: call.call_id,
      name: call.name,
      arguments_delta: args.slice(0, split),
    },
    { type: "tool_call.delta", index: 0, arguments_delta: args.slice(split) },
    { type: "usage", usage: estimateUsage(text) },
    { type: "done", finish_reason: "tool_calls" },
  );
  return chunks;
}
