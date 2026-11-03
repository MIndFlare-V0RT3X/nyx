// SPDX-License-Identifier: AGPL-3.0-or-later
// Zod schema for plugin manifests. Unknown keys are rejected; capability
// values come from the frozen @nyx/protocol schema so the 13-value set cannot
// drift. Per protocol's own convention, types and schemas are kept in sync by
// hand — the compile-time assertions below fail the build on drift.

import { z } from "zod";
import { CapabilitySchema } from "@nyx/protocol";
import type { HookName, PluginManifest } from "@nyx/protocol";

/** The four hook names, kept in sync with protocol's HookMap by hand. */
export const HOOK_NAMES = [
  "context.initialize",
  "action.before",
  "action.after",
  "feedback.recover",
] as const satisfies readonly HookName[];

// Compile-time completeness: every HookName must appear in HOOK_NAMES.
type AllHookNamesCovered = [HookName] extends [(typeof HOOK_NAMES)[number]] ? true : never;
const hookNamesAreComplete: true = null as unknown as AllHookNamesCovered;
void hookNamesAreComplete;

export const pluginManifestSchema = z
  .object({
    // ':' is the separator of the `plugin:<name>:` service namespace; allowing
    // it would let one plugin's namespace prefix another's.
    name: z
      .string()
      .min(1)
      .refine((n) => !n.includes(":"), { message: "must not contain ':'" }),
    version: z.string().min(1),
    nyx: z.string().min(1),
    capabilities: z.array(CapabilitySchema),
    dependencies: z.array(z.string().min(1)).optional(),
    hooks: z.array(z.enum(HOOK_NAMES)).optional(),
    tools: z.array(z.string().min(1)).optional(),
    permissions: z
      .object({
        fs: z.array(z.string().min(1)).optional(),
        net: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ParsedPluginManifest = z.infer<typeof pluginManifestSchema>;

// Compile-time guard: a parsed manifest must satisfy the frozen contract type.
const parsedManifestIsPluginManifest: PluginManifest = null as unknown as ParsedPluginManifest;
void parsedManifestIsPluginManifest;

/** Flatten a ZodError into human-readable "path: message" strings. */
export function manifestIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
}
