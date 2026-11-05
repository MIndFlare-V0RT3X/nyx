// SPDX-License-Identifier: AGPL-3.0-or-later
// The split agent's mock providers: the reusable text-only default (the
// zero-config fallback, same contract as the CLI's) and a scriptable mock
// for tests — the e2e drives real tool rounds by passing --mock-script.

import { readFile } from "node:fs/promises";
import type { CompletionRequest, ModelChunk, ModelInfo, ModelProvider } from "@nyx/protocol";
import { MockProvider, mockTextTurn, type MockTurn } from "@nyx/model";

export const MOCK_PROVIDER_MESSAGE = "mock reply (split mode)";

/** A `kind: mock` provider that never runs out: fresh one-turn text script. */
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
 * A scriptable mock for split tests: reads a JSON file of MockTurn[] (the
 * same shape @nyx/model's MockProvider consumes — the file IS the provider
 * contract) and serves it in order; exhausted script = typed ProviderError,
 * exactly like the in-process MockProvider.
 */
export class ScriptedFileMockProvider implements ModelProvider {
  readonly id: string;
  private readonly inner: MockProvider;

  constructor(id: string, script: MockTurn[]) {
    this.id = id;
    this.inner = new MockProvider(id, script);
  }

  static async fromFile(id: string, file: string): Promise<ScriptedFileMockProvider> {
    const text = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error(`mock script ${file} must be a JSON array of MockTurn`);
    }
    return new ScriptedFileMockProvider(id, parsed as MockTurn[]);
  }

  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }

  async *complete(req: CompletionRequest): AsyncGenerator<ModelChunk, void, void> {
    yield* this.inner.complete(req);
  }
}
