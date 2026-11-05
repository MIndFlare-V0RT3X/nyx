// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §2.3 — evidence verification: every finding's evidence artifacts
// are read from the engagement workspace and their sha256 re-verified
// against the recorded hash BEFORE a report embeds them. A finding without
// a hash-verified artifact is not a finding (hard rule #5).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FindingEvidence } from "../findings/schema.js";

export class EvidenceError extends Error {
  constructor(
    readonly code: "missing" | "hash_mismatch" | "escape",
    message: string,
  ) {
    super(message);
    this.name = "EvidenceError";
  }
}

export interface VerifiedEvidence extends FindingEvidence {
  bytes: number;
  absolute_path: string;
}

/**
 * Verify one finding's evidence list against the workspace on disk. Every
 * path must stay inside `root` (no ../ escapes), exist, and hash to the
 * recorded value. Returns the verified entries with sizes.
 */
export async function verifyEvidence(
  root: string,
  evidence: readonly FindingEvidence[],
): Promise<VerifiedEvidence[]> {
  const rootReal = realpathSync(resolve(root));
  const verified: VerifiedEvidence[] = [];
  for (const artifact of evidence) {
    const abs = resolve(join(rootReal, artifact.path));
    // Lexical containment AND symlink resolution: a symlink planted inside
    // the workspace cannot redirect the evidence read outside it (R2-2).
    let real: string;
    try {
      real = realpathSync(abs);
    } catch (err) {
      throw new EvidenceError(
        "missing",
        `evidence artifact ${artifact.path} not found in ${rootReal}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (real !== rootReal && !real.startsWith(rootReal + "/")) {
      throw new EvidenceError(
        "escape",
        `evidence path ${JSON.stringify(artifact.path)} resolves outside the engagement workspace (symlink?)`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(real);
    } catch (err) {
      throw new EvidenceError(
        "missing",
        `evidence artifact ${artifact.path} not found in ${rootReal}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== artifact.hash) {
      throw new EvidenceError(
        "hash_mismatch",
        `evidence artifact ${artifact.path} hashes to ${hash} but the finding recorded ` +
          `${artifact.hash} — the artifact changed after the finding was recorded`,
      );
    }
    verified.push({ ...artifact, bytes: bytes.byteLength, absolute_path: abs });
  }
  return verified;
}
