// SPDX-License-Identifier: AGPL-3.0-or-later
// Runtime validation mirror of the protocol `PolicyRule` type. zod is not a
// declared dependency of this package, so this is a hand-rolled validator
// with a zod-flavored API (parse / safeParse). Field names are identical to
// the protocol type — config and server reuse this for input validation.

import { CodedError } from "./errors.js";
import type { Decision, PolicyRule } from "@nyx/protocol";

const RISK_TIERS: readonly string[] = ["R0", "R1", "R2", "R3", "R4"];
const CAPABILITIES: readonly string[] = [
  "fs.read",
  "fs.write",
  "fs.delete",
  "proc.spawn",
  "proc.kill",
  "net.egress",
  "net.listen",
  "browser.control",
  "desktop.control",
  "credential.use",
  "host.access",
  "git.push",
  "deploy",
];
const DECISIONS: readonly string[] = ["allow", "ask", "deny"];

const MATCH_FIELDS = new Set([
  "tool",
  "capability",
  "risk",
  "path_prefix",
  "host",
  "owner_only",
]);
const RULE_FIELDS = new Set(["id", "match", "decision", "reason", "immutable"]);

export type SafeParseResult =
  | { success: true; data: PolicyRule }
  | { success: false; error: string };

export interface PolicyRuleSchema {
  parse(value: unknown): PolicyRule;
  safeParse(value: unknown): SafeParseResult;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(value: unknown): PolicyRule {
  if (!isObject(value)) throw new CodedError("validation_failed", "policy rule must be an object");

  const unknownTop = Object.keys(value).filter((k) => !RULE_FIELDS.has(k));
  if (unknownTop.length > 0) {
    throw new CodedError("validation_failed", `unknown policy rule field(s): ${unknownTop.join(", ")}`);
  }

  const { id, match, decision, reason, immutable } = value;
  if (typeof id !== "string" || id.length === 0) {
    throw new CodedError("validation_failed", "policy rule `id` must be a non-empty string");
  }
  if (typeof decision !== "string" || !DECISIONS.includes(decision)) {
    throw new CodedError("validation_failed", `policy rule \`decision\` must be one of ${DECISIONS.join("|")}`);
  }
  if (reason !== undefined && typeof reason !== "string") {
    throw new CodedError("validation_failed", "policy rule `reason` must be a string when present");
  }
  if (immutable !== undefined && typeof immutable !== "boolean") {
    throw new CodedError("validation_failed", "policy rule `immutable` must be a boolean when present");
  }
  if (!isObject(match)) {
    throw new CodedError("validation_failed", "policy rule `match` must be an object");
  }

  const unknownMatch = Object.keys(match).filter((k) => !MATCH_FIELDS.has(k));
  if (unknownMatch.length > 0) {
    throw new CodedError("validation_failed", `unknown match field(s): ${unknownMatch.join(", ")}`);
  }
  if (Object.keys(match).length === 0) {
    throw new CodedError("validation_failed", "policy rule `match` must not be empty");
  }

  const checkStringOrList = (
    field: string,
    allowed?: readonly string[],
  ): void => {
    const v = match[field];
    if (v === undefined) return;
    const items = Array.isArray(v) ? v : [v];
    if (items.length === 0) {
      throw new CodedError("validation_failed", `match.${field} must not be an empty list`);
    }
    for (const item of items) {
      if (typeof item !== "string" || item.length === 0) {
        throw new CodedError("validation_failed", `match.${field} entries must be non-empty strings`);
      }
      if (allowed && !allowed.includes(item)) {
        throw new CodedError("validation_failed", `match.${field} has invalid value: ${item}`);
      }
    }
  };

  checkStringOrList("tool");
  checkStringOrList("capability", CAPABILITIES);
  checkStringOrList("risk", RISK_TIERS);

  const pathPrefix = match.path_prefix;
  if (pathPrefix !== undefined && typeof pathPrefix !== "string") {
    throw new CodedError("validation_failed", "match.path_prefix must be a string when present");
  }
  const host = match.host;
  if (host !== undefined && typeof host !== "string") {
    throw new CodedError("validation_failed", "match.host must be a string when present");
  }
  const ownerOnly = match.owner_only;
  if (ownerOnly !== undefined && typeof ownerOnly !== "boolean") {
    throw new CodedError("validation_failed", "match.owner_only must be a boolean when present");
  }

  return {
    id,
    match: match as PolicyRule["match"],
    decision: decision as Decision,
    ...(reason !== undefined ? { reason } : {}),
    ...(immutable !== undefined ? { immutable } : {}),
  };
}

/** zod-style validator for PolicyRule (strict: unknown fields are rejected). */
export const policyRuleSchema: PolicyRuleSchema = {
  parse(value: unknown): PolicyRule {
    return validate(value);
  },
  safeParse(value: unknown): SafeParseResult {
    try {
      return { success: true, data: validate(value) };
    } catch (err) {
      if (err instanceof CodedError) return { success: false, error: err.message };
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
