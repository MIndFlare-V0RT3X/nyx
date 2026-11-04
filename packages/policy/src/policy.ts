// SPDX-License-Identifier: AGPL-3.0-or-later
// Deny-first policy engine. Structural invariants are hardcoded and evaluated
// first; no config rule can weaken them. Resolution order: deny > ask > allow,
// and unknown actions escalate to ask.

import { createHash } from "node:crypto";
import { canonicalJson } from "@nyx/protocol";
import type { ActionRequest, PolicyRule, PolicyVerdict } from "@nyx/protocol";

/** Capabilities that always require at least an "ask", invariantly. */
const DANGEROUS_CAPABILITIES: readonly string[] = [
  "host.access",
  "credential.use",
  "git.push",
  "deploy",
];

export interface PolicyEngineOptions {
  /** Injectable clock (reserved: verdicts carry no timestamps in Phase 0). */
  now?: () => number;
}

/**
 * sha256 over canonicalJson({ tool, input, risk }). The exact-action binding:
 * identical logical input yields an identical digest regardless of key order.
 */
export function computeActionDigest(req: ActionRequest): string {
  const canonical = canonicalJson({ tool: req.tool, input: req.input, risk: req.risk });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** One-line, human-readable sketch of the input, capped at 120 chars. */
function sketchInput(input: unknown): string {
  let sketch: string;
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    const keyParams = ["path", "url", "host"].filter((k) => typeof obj[k] === "string");
    sketch =
      keyParams.length > 0
        ? keyParams.map((k) => `${k}=${JSON.stringify(obj[k])}`).join(" ")
        : canonicalJson(input);
  } else {
    sketch = canonicalJson(input);
  }
  return sketch.length > 120 ? `${sketch.slice(0, 117)}...` : sketch;
}

/** `"<tool>" on <sketch> [risk R2]` — bound to this exact action. */
export function summarizeAction(req: ActionRequest): string {
  return `"${req.tool}" on ${sketchInput(req.input)} [risk ${req.risk}]`;
}

/**
 * Phase 0 match semantics for path_prefix/host rules: a top-level string
 * field `path` (resp. `host`) of the input is prefix-matched; if the input
 * has no such field, the prefix is matched against the input's canonical
 * JSON serialization. Deliberately crude and documented — real field-aware
 * matching lands with the config schema work.
 */
function prefixMatch(prefix: string, input: unknown, field: "path" | "host"): boolean {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value === "string") return value.startsWith(prefix);
  }
  return canonicalJson(input).startsWith(prefix);
}

function ruleMatches(rule: PolicyRule, req: ActionRequest): boolean {
  const m = rule.match;
  if (m.tool !== undefined) {
    const tools = Array.isArray(m.tool) ? m.tool : [m.tool];
    if (!tools.includes(req.tool)) return false;
  }
  if (m.capability !== undefined) {
    const caps = Array.isArray(m.capability) ? m.capability : [m.capability];
    if (!req.capabilities.some((c) => caps.includes(c))) return false;
  }
  if (m.risk !== undefined) {
    const risks = Array.isArray(m.risk) ? m.risk : [m.risk];
    if (!risks.includes(req.risk)) return false;
  }
  // owner_only: the rule only applies when the actor is the owner.
  if (m.owner_only === true && req.actor_id !== "owner") return false;
  if (m.path_prefix !== undefined && !prefixMatch(m.path_prefix, req.input, "path")) return false;
  if (m.host !== undefined && !prefixMatch(m.host, req.input, "host")) return false;
  return true;
}

export class PolicyEngineImpl {
  private readonly rules: PolicyRule[];
  private readonly now: () => number;

  constructor(rules: PolicyRule[], opts: PolicyEngineOptions = {}) {
    this.rules = rules;
    // Injectable clock; verdicts carry no timestamps in Phase 0, so it is
    // accepted (and validated) now but not yet read.
    this.now = opts.now ?? Date.now;
  }

  async evaluate(req: ActionRequest): Promise<PolicyVerdict> {
    const action_digest = computeActionDigest(req);
    const summary = summarizeAction(req);

    // Immutable invariants, evaluated first. They can raise a decision to
    // "ask" but never lower one: a config deny still denies.
    const r4 = req.risk === "R4";
    const dangerous = req.capabilities.some((c) => DANGEROUS_CAPABILITIES.includes(c));

    const matches = this.rules.filter((r) => ruleMatches(r, req));

    const firstDeny = matches.find((r) => r.decision === "deny");
    if (firstDeny) {
      return { decision: "deny", rule_id: firstDeny.id, action_digest, summary };
    }

    if (r4) {
      return {
        decision: "ask",
        rule_id: "invariant:r4-owner-approval",
        action_digest,
        summary: `${summary} — owner approval required`,
      };
    }
    if (dangerous) {
      return {
        decision: "ask",
        rule_id: "invariant:dangerous-capability",
        action_digest,
        summary: `${summary} — dangerous capability requires approval`,
      };
    }

    const firstAsk = matches.find((r) => r.decision === "ask");
    if (firstAsk) {
      return { decision: "ask", rule_id: firstAsk.id, action_digest, summary };
    }

    const allows = matches.filter((r) => r.decision === "allow");
    if (allows.length > 0) {
      const last = allows[allows.length - 1];
      if (last) return { decision: "allow", rule_id: last.id, action_digest, summary };
    }

    // Deny-first: an unknown action escalates to ask.
    return { decision: "ask", rule_id: "default:unknown-action", action_digest, summary };
  }
}
