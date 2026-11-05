// SPDX-License-Identifier: AGPL-3.0-or-later
// `nyx plugin audit <dir>` — the static trust audit of a third-party plugin
// directory (Phase 7.2): manifest v2 validity, index.js integrity, Ed25519
// signature against the operator's trusted keys, and the declared capability
// surface. Exit 0 when every check passes, 1 otherwise.
//
// The DYNAMIC half of the audit (declared vs exercised capabilities) lives
// in the running kernel: kernel.list_plugins() warns when a plugin declares
// capabilities it never uses. This static half is what the operator runs
// BEFORE loading anything.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  checkManifestSignature,
  loadTrustedKeys,
  pluginManifestSchema,
  resolveSignatureMode,
  sha256Hex,
} from "@nyx/kernel";
import { manifestIssues } from "@nyx/kernel";
import type { PluginManifest } from "@nyx/protocol";

export type PluginAuditStatus = "ok" | "warn" | "fail";

export interface PluginAuditCheck {
  name: string;
  status: PluginAuditStatus;
  detail: string;
}

export interface PluginAuditReport {
  checks: PluginAuditCheck[];
  exit_code: 0 | 1;
}

export interface PluginAuditOptions {
  /** Trusted keys JSON file (default: ~/.nyx/plugins/trusted-keys.json). */
  trusted_keys_file?: string;
  /** Env source (default process.env): NYX_ENV for the effective mode line. */
  env?: NodeJS.ProcessEnv;
  /** Configured signature mode (config.plugins.signature_mode), if any. */
  configured_mode?: "strict" | "warn" | "off";
}

function audit(
  name: string,
  status: PluginAuditStatus,
  detail: string,
  checks: PluginAuditCheck[],
): void {
  checks.push({ name, status, detail });
}

export async function pluginAudit(dir: string, opts?: PluginAuditOptions): Promise<PluginAuditReport> {
  const checks: PluginAuditCheck[] = [];
  const env = opts?.env ?? process.env;
  const effectiveMode = resolveSignatureMode(opts?.configured_mode, env.NYX_ENV);
  audit(
    "signature mode",
    "ok",
    `effective mode "${effectiveMode}"${opts?.configured_mode !== undefined ? ` (configured: ${opts.configured_mode})` : " (default)"}`,
    checks,
  );

  let manifestText: string;
  let indexSource: string;
  try {
    [manifestText, indexSource] = await Promise.all([
      readFile(join(dir, "manifest.json"), "utf8"),
      readFile(join(dir, "index.js"), "utf8"),
    ]);
  } catch (err) {
    const e = err as { code?: string };
    audit(
      "files",
      "fail",
      `cannot read ${dir}/manifest.json + index.js (${e.code ?? "read error"}); a plugin directory is { manifest.json, index.js }`,
      checks,
    );
    return { checks, exit_code: 1 };
  }
  audit("files", "ok", "manifest.json + index.js readable", checks);

  let manifestUnknown: unknown;
  try {
    manifestUnknown = JSON.parse(manifestText);
  } catch (err) {
    audit(
      "manifest",
      "fail",
      `manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      checks,
    );
    return { checks, exit_code: 1 };
  }
  const parsed = pluginManifestSchema.safeParse(manifestUnknown);
  if (!parsed.success) {
    audit(
      "manifest",
      "fail",
      `manifest v2 validation failed: ${manifestIssues(parsed.error).join("; ")}`,
      checks,
    );
    return { checks, exit_code: 1 };
  }
  const manifest: PluginManifest = parsed.data;
  audit(
    "manifest",
    "ok",
    `v2 · ${manifest.name}@${manifest.version} · nyx ${manifest.nyx}`,
    checks,
  );

  // Integrity.
  const actual = sha256Hex(indexSource);
  if (actual === manifest.integrity) {
    audit("integrity", "ok", `index.js sha256 matches (${actual.slice(0, 16)}…)`, checks);
  } else {
    audit(
      "integrity",
      "fail",
      `index.js hashes to ${actual.slice(0, 16)}… but the manifest declares ${manifest.integrity.slice(0, 16)}… — the code changed after the manifest was written`,
      checks,
    );
  }

  // Signature + trust anchor.
  const keysFile =
    opts?.trusted_keys_file?.replace(/^~/, homedir()) ??
    join(homedir(), ".nyx/plugins/trusted-keys.json");
  let trustedKeys: string[];
  try {
    trustedKeys = (await loadTrustedKeys(keysFile)).keys;
  } catch (err) {
    audit(
      "trust anchor",
      "fail",
      `trusted-keys file ${keysFile} is malformed: ${err instanceof Error ? err.message : String(err)}`,
      checks,
    );
    return { checks, exit_code: 1 };
  }
  const check = checkManifestSignature(manifest, trustedKeys);
  if (!check.signed) {
    audit(
      "signature",
      effectiveMode === "strict" ? "fail" : "warn",
      `unsigned — rejected in strict mode, loaded with a warning in warn mode (trusted keys: ${trustedKeys.length} in ${keysFile})`,
      checks,
    );
  } else if (!check.trusted) {
    audit(
      "signature",
      "fail",
      `signed by a key NOT in ${keysFile} — rejected in EVERY mode (strict and warn)`,
      checks,
    );
  } else if (!check.valid) {
    audit(
      "signature",
      "fail",
      "signature does not verify over the canonical manifest (tampered after signing)",
      checks,
    );
  } else {
    audit("signature", "ok", `valid, from trusted key ${manifest.signature?.public_key.slice(0, 16)}…`, checks);
  }

  // Capability surface (static half; the runtime half is kernel.list_plugins()).
  if (manifest.capabilities.length === 0) {
    audit("capabilities", "ok", "declares none (a pure tool plugin)", checks);
  } else {
    audit(
      "capabilities",
      "ok",
      `declares [${manifest.capabilities.join(", ")}] — kernel.list_plugins() will warn at runtime if any go unused`,
      checks,
    );
  }
  if (manifest.dependencies !== undefined && manifest.dependencies.length > 0) {
    audit(
      "dependencies",
      "ok",
      manifest.dependencies.map((d) => `${d.name}@${d.version_range}`).join(", "),
      checks,
    );
  }

  const exit_code: 0 | 1 = checks.some((c) => c.status === "fail") ? 1 : 0;
  return { checks, exit_code };
}

export function renderPluginAudit(dir: string, report: PluginAuditReport): string {
  const lines = [`plugin audit — ${dir}`, ""];
  for (const check of report.checks) {
    const mark = check.status === "ok" ? "  ok " : check.status === "warn" ? " warn" : " FAIL";
    lines.push(`[${mark}] ${check.name}: ${check.detail}`);
  }
  lines.push("");
  lines.push(
    report.exit_code === 0
      ? "audit passed (warnings allowed)"
      : "audit FAILED — fix the FAIL lines before loading this plugin",
  );
  return lines.join("\n");
}
