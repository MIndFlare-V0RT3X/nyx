// SPDX-License-Identifier: AGPL-3.0-or-later
// Zod schema for plugin manifests (v2 — Phase 7.2). Unknown keys are
// rejected; capability values come from the frozen @nyx/protocol schema so
// the set cannot drift. Per protocol's own convention, types and schemas are
// kept in sync by hand — the compile-time assertions below fail the build on
// drift.
//
// v2 over v1: `manifest_version: 2` discriminates; `dependencies` carry
// version ranges ({name, version_range}); `integrity` pins index.js (sha256
// hex); `signature` (optional) anchors the manifest to an operator-trusted
// Ed25519 key. v1 manifests fail validation and get a migration message via
// `v1MigrationHints`.

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
    manifest_version: z.literal(2, {
      errorMap: () => ({
        message:
          "must be 2 — manifest v1 is no longer accepted (see v1MigrationHints / templates/plugin)",
      }),
    }),
    version: z.string().min(1),
    nyx: z.string().min(1),
    capabilities: z.array(CapabilitySchema),
    dependencies: z
      .array(
        z
          .object({
            name: z.string().min(1),
            version_range: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    integrity: z
      .string()
      .regex(/^[0-9a-f]{64}$/, { message: "must be the 64-hex sha256 of the plugin's index.js" }),
    // R2-2 (fan-out): every sibling CODE file (index.js's transitive imports
    // land here) — the loader refuses a code file on disk that is not
    // listed-and-hashed. Documentation files (README.md, …) are exempt.
    files: z
      .record(
        z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, {
          message: "must be a relative path inside the plugin directory",
        }),
        z.string().regex(/^[0-9a-f]{64}$/, { message: "must be a 64-hex sha256" }),
      )
      .optional(),
    signature: z
      .object({
        public_key: z.string().regex(/^[0-9a-f]{64}$/, {
          message: "must be a 64-hex Ed25519 public key",
        }),
        signature: z.string().regex(/^[0-9a-f]{128}$/, {
          message: "must be a 128-hex Ed25519 signature",
        }),
      })
      .strict()
      .optional(),
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

/**
 * Targeted migration guidance when a manifest looks like v1: string-array
 * dependencies, a missing `manifest_version`, or a missing `integrity`. The
 * kernel appends these to the validation issues so the author sees WHAT to
 * change, not just that parsing failed.
 */
export function v1MigrationHints(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const hints: string[] = [];
  const candidate = raw as Record<string, unknown>;
  if (candidate.manifest_version === undefined) {
    hints.push('add "manifest_version": 2');
  }
  if (Array.isArray(candidate.dependencies)) {
    const hasStrings = candidate.dependencies.some((d) => typeof d === "string");
    if (hasStrings) {
      hints.push(
        'dependencies must be objects: replace "dep-name" with { "name": "dep-name", "version_range": ">=1.0.0" }',
      );
    }
  }
  if (typeof candidate.integrity !== "string") {
    hints.push(
      'add "integrity": the sha256 hex of your index.js (templates/plugin/scripts/sign-manifest.mjs computes it)',
    );
  }
  return hints;
}

/** Flatten a ZodError into human-readable "path: message" strings. */
export function manifestIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
}
