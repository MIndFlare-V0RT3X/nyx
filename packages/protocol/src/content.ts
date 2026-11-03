// SPDX-License-Identifier: AGPL-3.0-or-later
// Content blocks, messages, and model-facing tool schemas.

import type { JsonSchema } from "./util.js";
import type { ToolOutput } from "./tools.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data_base64: string }
  | { type: "tool_use"; call_id: string; name: string; input: unknown }
  | { type: "tool_result"; call_id: string; output: ToolOutput }
  | { type: "reasoning"; text: string; encrypted?: string };

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
  name?: string;
}

/** Model-facing tool description (curated spec — the model never sees handlers). */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: JsonSchema;
}
