// SPDX-License-Identifier: AGPL-3.0-or-later
// Zod input schemas for the builtin tools — the single validation truth for
// each builtin. The runtime looks schemas up by tool name (this map);
// registerBuiltinTools renders each one into the model-facing input_schema.
// Tests import these to construct valid/invalid calls.

import { z } from "zod";

export const fsReadInput = z.object({
  path: z
    .string()
    .describe('File path inside the sandbox workdir, e.g. "notes.txt" or "sub/dir/file.md".'),
});

export const fsListInput = z.object({
  path: z
    .string()
    .describe('Directory path inside the sandbox workdir. Defaults to "." (the workdir itself).')
    .default("."),
});

export const fsWriteInput = z.object({
  path: z
    .string()
    .describe("File path inside the sandbox workdir. The parent directory must already exist."),
  content: z.string().describe("UTF-8 text content to write (the file is overwritten)."),
});

export const shellExecInput = z.object({
  cmd: z
    .string()
    .describe("Shell command line, executed with /bin/bash -c inside the sandbox workdir."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Optional wall-clock kill timeout for the command, in milliseconds (max 600000)."),
});

export const webFetchInput = z.object({
  url: z
    .string()
    .describe(
      "Absolute http(s) URL to fetch. Non-http(s) schemes and embedded userinfo (user:pass@) are rejected.",
    ),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(16_777_216)
    .optional()
    .describe("Optional cap on the response body in bytes (default 1048576, max 16777216)."),
});

/**
 * Per-tool zod input schemas for the builtins, keyed by tool name. The tool
 * runtime uses this map for validation; the schemas are also the source for
 * each builtin's model-facing input_schema.
 */
export const builtinInputSchemas: ReadonlyMap<string, z.ZodTypeAny> = new Map<
  string,
  z.ZodTypeAny
>([
  ["fs.read", fsReadInput],
  ["fs.list", fsListInput],
  ["fs.write", fsWriteInput],
  ["shell.exec", shellExecInput],
  ["web.fetch", webFetchInput],
]);
