// SPDX-License-Identifier: AGPL-3.0-or-later
// Small formatting helpers shared by every command's output path.

import type { Usage } from "@nyx/protocol";

/** Truncate long single-line values for tables and transcripts. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Compact JSON for transcript lines (single line, no padding). */
export function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "(unserializable)";
  }
}

/** ISO timestamp (UTC) for table cells. */
export function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\..+$/, "Z");
}

/** "2m 41s" / "58s" / "<1s" — remaining TTL and similar durations. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  if (s < 1) return "<1s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/** "in 12, out 34, total 46" — the usage footer format. */
export function formatUsage(usage: Usage): string {
  const total = usage.total_tokens ?? usage.input_tokens + usage.output_tokens;
  return `in ${usage.input_tokens}, out ${usage.output_tokens}, total ${total}`;
}

/** Short model-facing description of a tool output for transcript lines. */
export function describeToolOutput(output: {
  kind: string;
  text?: string;
  json?: unknown;
  path?: string;
  bytes?: number;
}): string {
  switch (output.kind) {
    case "text":
      return truncate(output.text ?? "", 80);
    case "json":
      return truncate(compactJson(output.json), 80);
    case "file":
    case "artifact":
      return `${output.path ?? "?"} (${output.bytes ?? 0} bytes)`;
    default:
      return output.kind;
  }
}
