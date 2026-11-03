// SPDX-License-Identifier: AGPL-3.0-or-later
// Artifact spill plumbing shared by the tool runtime (oversized outputs) and
// the web.fetch builtin (binary bodies). Artifacts live under
// <workdir>/.nyx/artifacts/ and are written through the sandbox — the
// runtime never touches the host filesystem directly.

import * as path from "node:path";
import type { Sandbox } from "@nyx/protocol";

/** Sandbox-relative directory every artifact is spilled into. */
export const ARTIFACTS_DIR = ".nyx/artifacts";

/** Quote a string for safe interpolation into a sh command. */
function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Ensure <workdir>/.nyx/artifacts exists. Done via sandbox.exec (`mkdir -p`)
 * so the same code works for every provider; the path is runtime-controlled,
 * never model-controlled, so no policy stop is needed. Sandbox providers do
 * not create parent directories on writeFile.
 */
export async function ensureArtifactsDir(sandbox: Sandbox): Promise<void> {
  const dir = path.join(sandbox.workdir, ARTIFACTS_DIR);
  const r = await sandbox.exec(`mkdir -p ${shQuote(dir)}`);
  if (r.exit_code !== 0) {
    throw new Error(
      `failed to create ${ARTIFACTS_DIR} in the sandbox (exit ${r.exit_code}): ${r.stderr.trim()}`,
    );
  }
}

/**
 * Model-generated call ids are not trusted inside file names: keep the
 * conservative [A-Za-z0-9._-] set so a crafted id can neither traverse
 * (`../x`) nor smuggle separators.
 */
export function safeArtifactName(callId: string): string {
  const cleaned = callId.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "artifact";
}

/** Absolute artifact path (<workdir>/.nyx/artifacts/<name><ext>). */
export function artifactAbsPath(sandbox: Sandbox, name: string, ext: string): string {
  return path.join(sandbox.workdir, ARTIFACTS_DIR, `${name}${ext}`);
}
