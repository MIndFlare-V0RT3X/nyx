// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.2 — the third-party plugin loader: the trust boundary.
//
// A plugin DIRECTORY is third-party code until it proves otherwise:
//
//   manifest.json  must parse as manifest v2 (a v1 manifest is rejected
//                  with a migration message)
//   index.js       must hash (sha256) to the manifest's `integrity`
//   signature      strict: required, from a trusted key, and valid
//                  warn:   optional, but IF PRESENT it must be from a
//                          trusted key and valid (an unanchored signature
//                          claim is rejected even in warn mode)
//                  off:    no check — requires NYX_ENV=development AND the
//                          explicit --allow-unsigned-plugins flag (enforced
//                          at config load, the Phase 6 egress escape-hatch
//                          pattern)
//
// Only after all of that is the module imported and its `setup` handed to
// `kernel.use` — which re-validates the manifest, enforces capabilities,
// and refuses plugin-set mutation (R3-14).
//
// index.js contract: export `setup(kernel)` (required) and optionally
// `teardown()`. The manifest is the FILE's, not the module's — the module
// cannot lie about what it is.

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin, PluginManifest } from "@nyx/protocol";
import { pluginManifestSchema, manifestIssues, v1MigrationHints } from "./manifest.js";
import { checkManifestSignature, sha256Hex, type SignatureCheck } from "./signature.js";
import {
  ManifestValidationError,
  PluginIntegrityError,
  PluginSignatureError,
} from "./errors.js";

export type SignatureMode = "strict" | "warn" | "off";

export interface LoadPluginOptions {
  /** Signature gate. Default "strict" (production posture). */
  mode?: SignatureMode;
  /** Trusted hex Ed25519 public keys (trusted-keys.json contents). */
  trustedKeys?: readonly string[];
  /** Warn-mode notices land here (the loader never console.logs). */
  logger?: { warn(message: string): void };
}

export interface LoadedPluginModule {
  /** Ready for `kernel.use(plugin)`; manifest is the verified file's. */
  plugin: Plugin;
  manifest: PluginManifest;
  /** Human-readable notices (unsigned-in-warn, over-declared capabilities). */
  warnings: string[];
  signature: {
    signed: boolean;
    /** Only meaningful when signed: the key was in the trusted set. */
    trusted: boolean;
    /** Only meaningful when signed: the Ed25519 signature verified. */
    valid: boolean;
  };
}

interface PluginModule {
  setup?: unknown;
  teardown?: unknown;
}

/**
 * Load one plugin directory through the full trust pipeline. Every failure
 * mode throws a typed kernel error; nothing is imported until the manifest,
 * integrity, and signature gates have all passed.
 */
export async function loadPluginDirectory(
  dir: string,
  opts?: LoadPluginOptions,
): Promise<LoadedPluginModule> {
  const mode: SignatureMode = opts?.mode ?? "strict";
  const trustedKeys = opts?.trustedKeys ?? [];
  const warnings: string[] = [];

  const manifestFile = path.join(dir, "manifest.json");
  const indexFile = path.join(dir, "index.js");
  let manifestRaw: string;
  let indexSource: string;
  try {
    [manifestRaw, indexSource] = await Promise.all([
      fsp.readFile(manifestFile, "utf8"),
      fsp.readFile(indexFile, "utf8"),
    ]);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    throw new ManifestValidationError(path.basename(dir), [
      `could not read ${path.basename(dir)}/manifest.json and index.js: ${e.code ?? e.message ?? "read error"} — a plugin directory is { manifest.json, index.js }`,
    ]);
  }

  let manifestUnknown: unknown;
  try {
    manifestUnknown = JSON.parse(manifestRaw);
  } catch (err) {
    throw new ManifestValidationError(path.basename(dir), [
      `manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  const parsed = pluginManifestSchema.safeParse(manifestUnknown);
  if (!parsed.success) {
    const issues = manifestIssues(parsed.error);
    const hints = v1MigrationHints(manifestUnknown);
    throw new ManifestValidationError(
      pluginNameOf(manifestUnknown, dir),
      hints.length > 0 ? [...issues, `v1→v2 migration: ${hints.join("; ")}`] : issues,
    );
  }
  const manifest: PluginManifest = parsed.data;

  // Integrity: the manifest's word about the code vs the code itself.
  // Checked in EVERY mode except "off" — a lying manifest is a lying
  // manifest regardless of signature policy.
  if (mode !== "off") {
    const actual = sha256Hex(indexSource);
    if (actual !== manifest.integrity) {
      throw new PluginIntegrityError(manifest.name, manifest.integrity, actual);
    }
    // R2-2 (fan-out): integrity + signature pin MORE than index.js — every
    // code file in the directory must be listed in `files` with its exact
    // sha256. An unlisted or tampered sibling is a tampered plugin.
    const declared = manifest.files ?? {};
    const onDisk = await fsp.readdir(dir, { recursive: false });
    for (const name of onDisk) {
      if (!/\.(js|mjs|cjs|ts)$/.test(name)) continue; // docs/config exempt
      if (name === "index.js") continue; // covered by integrity
      const bytes = await fsp.readFile(path.join(dir, name));
      const hash = sha256Hex(bytes);
      const expected = declared[name];
      if (expected === undefined) {
        throw new PluginIntegrityError(
          manifest.name,
          `listed in files ("${name}" is code on disk with no manifest entry)`,
          hash,
        );
      }
      if (expected !== hash) {
        throw new PluginIntegrityError(manifest.name, expected, hash);
      }
    }
    // And every declared file must exist (a stale manifest entry is a lie too).
    for (const name of Object.keys(declared)) {
      if (!(await fsp
        .stat(path.join(dir, name))
        .then(() => true)
        .catch(() => false))) {
        throw new PluginIntegrityError(
          manifest.name,
          `declared in files but absent on disk ("${name}")`,
          "-",
        );
      }
    }
  }

  // Signature gate.
  const check: SignatureCheck = checkManifestSignature(manifest, trustedKeys);
  if (check.signed) {
    if (mode !== "off") {
      if (!check.trusted) {
        throw new PluginSignatureError(
          manifest.name,
          "untrusted_key",
          `signing key ${manifest.signature?.public_key} is not in trusted-keys.json — a signature from an unanchored key is rejected in every mode`,
        );
      }
      if (!check.valid) {
        throw new PluginSignatureError(
          manifest.name,
          "invalid_signature",
          "the Ed25519 signature does not verify over the canonical manifest (tampered manifest, or signed over different content)",
        );
      }
    }
  } else if (mode === "strict") {
    throw new PluginSignatureError(
      manifest.name,
      "unsigned",
      'strict mode requires a signature: generate a keypair, add the public key to trusted-keys.json, and add the "signature" block (templates/plugin/README.md)',
    );
  } else if (mode === "warn") {
    warnings.push(
      `plugin "${manifest.name}" is unsigned — loaded in warn mode only; it would be rejected in strict mode`,
    );
    opts?.logger?.warn(`unsigned plugin "${manifest.name}" loaded (warn mode)`);
  }

  // Import ONLY after the gates. The module cannot override the manifest:
  // setup/teardown come from the module, the manifest comes from the file.
  const moduleUrl = pathToFileURL(indexFile).href;
  const imported = (await import(moduleUrl)) as Record<string, unknown>;
  const pluginModule = (imported.default ?? imported) as PluginModule;
  if (typeof pluginModule.setup !== "function") {
    throw new ManifestValidationError(manifest.name, [
      "index.js must export setup(kernel) (a default or named export)",
    ]);
  }
  const plugin: Plugin = {
    manifest,
    setup: pluginModule.setup.bind(pluginModule),
    ...(typeof pluginModule.teardown === "function"
      ? { teardown: pluginModule.teardown.bind(pluginModule) }
      : {}),
  };
  return {
    plugin,
    manifest,
    warnings,
    signature: {
      signed: check.signed,
      trusted: check.signed ? check.trusted : false,
      valid: check.signed ? check.valid : false,
    },
  };
}

function pluginNameOf(raw: unknown, dir: string): string {
  const candidate = (raw as { name?: unknown })?.name;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : path.basename(dir);
}

/**
 * Effective signature mode for a process: explicit config wins; the default
 * is strict in production, warn in development. ("off" itself must survive
 * config validation — it requires development env + the explicit CLI flag.)
 */
export function resolveSignatureMode(
  configured: "strict" | "warn" | "off" | undefined,
  nyxEnv: string | undefined,
): SignatureMode {
  if (configured !== undefined) return configured;
  return nyxEnv === "development" ? "warn" : "strict";
}
