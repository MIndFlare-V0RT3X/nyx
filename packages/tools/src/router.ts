// SPDX-License-Identifier: AGPL-3.0-or-later
// Tool routing: exact dotted-name match against the available definitions.
// An unknown name is a null return, never a crash — the runtime turns it into
// a `tool.error` (code "tool_unknown") and a model-facing text so the turn
// can continue.

import type { ToolCall, ToolDefinition, ToolRouter } from "@nyx/protocol";

export class ToolRouterImpl implements ToolRouter {
  select(call: ToolCall, available: ToolDefinition[]): ToolDefinition | null {
    for (const def of available) {
      if (def.name === call.name) return def;
    }
    return null;
  }
}
