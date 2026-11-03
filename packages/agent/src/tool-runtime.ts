// SPDX-License-Identifier: AGPL-3.0-or-later
// The tool-runtime service boundary. The loop never executes tools itself:
// at loop start it requires this structurally-typed service from the kernel's
// service registry (registered by the hosting surface under "tools.runtime").
// The shape is deliberately identical to @nyx/tools' ToolRuntime so the real
// implementation satisfies it without either package importing the other —
// the dependency direction stays one-way (agent → protocol only).

import type {
  Engagement,
  Logger,
  Sandbox,
  SessionEvent,
  ToolCall,
  ToolOutput,
} from "@nyx/protocol";

/** Everything the tool runtime receives per call. `emit` routes into the loop's event pump. */
export interface ToolRuntimeExecuteContext {
  session_id: string;
  turn_id: string;
  engagement: Engagement | null;
  sandbox: Sandbox;
  signal: AbortSignal;
  logger: Logger;
  emit: (e: SessionEvent) => void;
}

export interface ToolRuntimeExecuteOptions {
  /** Force the approval flow even when policy would allow (action.before "ask"). */
  force_ask?: boolean;
}

/**
 * Structurally compatible with @nyx/tools' ToolRuntime. Looked up at loop
 * start as kernel service "tools.runtime"; a missing registration is a typed
 * "not_implemented" failure — surfaces own the wiring.
 */
export interface ToolRuntimeService {
  execute(
    call: ToolCall,
    ctx: ToolRuntimeExecuteContext,
    opts?: ToolRuntimeExecuteOptions,
  ): Promise<ToolOutput>;
}

/**
 * Model-facing tool result. Tool output is untrusted data: it is wrapped in
 * trust markers and the BASE_PREAMBLE instructs data-only treatment. The
 * prompt-injection defense is structural (markers + contract), not cosmetic:
 * json/file/artifact outputs are reduced to a descriptor line inside the same
 * wrapper so nothing executable rides back into the context.
 */
export function wrapToolOutput(output: ToolOutput): ToolOutput {
  return { kind: "text", text: `<tool_output trust="untrusted">\n${renderInner(output)}\n</tool_output>` };
}

/** Model-facing result for an action the loop denied without execution (hook veto). */
export function denialToolOutput(detail: string): ToolOutput {
  return wrapToolOutput({ kind: "text", text: `action denied: ${detail}` });
}

function renderInner(output: ToolOutput): string {
  switch (output.kind) {
    case "text":
      return output.text;
    case "json":
      return JSON.stringify(output.json) ?? "undefined";
    case "file":
      return `file: ${output.path} (${output.bytes} bytes, ${output.mime})`;
    case "artifact":
      return `artifact: ${output.artifact_id} (${output.path}, ${output.bytes} bytes)`;
  }
}
