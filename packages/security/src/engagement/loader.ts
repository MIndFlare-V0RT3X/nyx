// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §1.2 — engagement file loading: read, validate, hash, warn, audit.
//
// The loaded engagement is IMMUTABLE for the session's lifetime: the caller
// binds the returned snapshot at session creation and never re-reads the
// file. The content hash pins exactly which bytes were authorized, so a file
// edited mid-session is inert (the session keeps its snapshot) and provably
// different from what was signed in.
//
// Load-time refusals (unreadable, malformed, schema failure, invalid targets,
// expired window) throw EngagementFileError — a bad file never becomes a
// session's scope. A not-yet-active window LOADS: the scope engine denies
// every action with `engagement_not_yet_active` until the window opens.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { validateTargets } from "@nyx/scope";
import type { Engagement } from "@nyx/protocol";
import {
  SecurityEngagementFileSchema,
  fileToEngagement,
  type SecurityEngagementFile,
} from "./schema.js";

/** Audit sink: the same shape `@nyx/policy`'s appendAudit accepts. */
export type EngagementAuditSink = (entry: {
  actor: string;
  action: string;
  payload: unknown;
}) => void;

export class EngagementFileError extends Error {
  constructor(
    readonly code:
      "unreadable" | "invalid_yaml" | "validation_failed" | "invalid_targets" | "expired",
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "EngagementFileError";
  }
}

/** A loaded engagement: the protocol snapshot plus its provenance. */
export interface LoadedEngagement {
  engagement: Engagement;
  /** sha256 hex of the raw file text — the tamper-evidence pin. */
  content_hash: string;
  /** Non-fatal load warnings (surfaced to the operator and the audit row). */
  warnings: string[];
  /** Absolute or given path of the file this came from. */
  file: string;
}

export interface LoadEngagementDeps {
  now?: () => number;
  /** When provided, a `security.engagement.loaded` audit row is emitted. */
  audit?: EngagementAuditSink;
}

export const ENGAGEMENT_LOADED_AUDIT_ACTION = "security.engagement.loaded";

export async function loadEngagementYaml(
  path: string,
  deps: LoadEngagementDeps = {},
): Promise<LoadedEngagement> {
  const now = deps.now ?? Date.now;

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new EngagementFileError(
      "unreadable",
      `cannot read engagement file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      path,
    );
  }

  // YAML is a superset of JSON: `--engagement` files written as JSON load too.
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new EngagementFileError(
      "invalid_yaml",
      `engagement file ${path} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      path,
    );
  }

  const parsed = SecurityEngagementFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new EngagementFileError(
      "validation_failed",
      `invalid engagement in ${path}: ${issues}`,
      path,
    );
  }

  const file: SecurityEngagementFile = parsed.data;
  const engagement = fileToEngagement(file);

  const problems = validateTargets(engagement.targets);
  if (problems.length > 0) {
    throw new EngagementFileError(
      "invalid_targets",
      `invalid engagement targets in ${path}: ${problems.join("; ")}`,
      path,
    );
  }

  const warnings: string[] = [];
  if (engagement.targets.cidrs.length === 0) {
    // Phase 5 §1.4: domain-only authorization is a warning at load and an
    // audit row — without CIDR ranges the DNS-rebinding IP validation of
    // checkResolvedTarget cannot apply (documented residual).
    warnings.push(
      "domain-only authorization: no CIDR ranges declared, so resolved-address " +
        "validation cannot apply — hostname-only authorization (see SECURITY-MODEL.md)",
    );
  }

  if (engagement.expires_at <= now()) {
    throw new EngagementFileError(
      "expired",
      `engagement ${engagement.id} in ${path} expired at ` +
        `${new Date(engagement.expires_at).toISOString()}`,
      path,
    );
  }

  const contentHash = createHash("sha256").update(text, "utf8").digest("hex");

  deps.audit?.({
    actor: "system:security",
    action: ENGAGEMENT_LOADED_AUDIT_ACTION,
    payload: {
      engagement_id: engagement.id,
      content_hash: contentHash,
      file: path,
      operator_id: engagement.operator_id,
      client: engagement.client,
      window: { start: engagement.starts_at, end: engagement.expires_at },
      techniques: engagement.techniques ?? [],
      targets: {
        domains: engagement.targets.domains,
        cidrs: engagement.targets.cidrs,
        urls: engagement.targets.urls ?? [],
      },
      warnings,
    },
  });

  return { engagement, content_hash: contentHash, warnings, file: path };
}
