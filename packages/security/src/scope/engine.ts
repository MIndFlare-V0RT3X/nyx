// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §1.3 layer 3 — the action-time scope check.
//
// Before a security tool fires, scope.check(action) answers ONE question:
// is this action authorized by the session's engagement? Every allow AND
// every deny writes an audit row carrying the engagement id and the action
// digest — the chain is the legal record (§1.7).
//
// Layering reminder: layer 1 (technique registry filter) already kept
// unauthorized TOOLS out of the session; layer 2 (checkResolvedTarget at
// the egress path) validates resolved addresses at connection time. This
// engine is the action-time gate the tool handlers call first — deny-first,
// exactly one audit row per check.

import { createHash } from "node:crypto";
import { canonicalJson } from "@nyx/protocol";
import type { Engagement, ScopeCheckResult, ScopeTargetQuery } from "@nyx/protocol";
import { checkTarget } from "@nyx/scope";
import type { EngagementAuditSink } from "../engagement/loader.js";
import { securityToolMeta } from "./tool_filter.js";

/** One action to authorize: the tool and every network target it touches. */
export interface ScopeAction {
  tool: string;
  targets: ScopeTargetQuery[];
}

export interface ScopeCheckOutcome {
  /**
   * "ask" is RESERVED for Phase 6 escalation flows (e.g. exploitation
   * techniques): Phase 5 engagements and tooling produce allow/deny only.
   */
  decision: "allow" | "deny" | "ask";
  reason: string;
  /** sha256 over canonical JSON of {tool, targets} — binds the audit row. */
  action_digest: string;
  /** The matching scope entry, when allowed. */
  matched?: string;
}

export interface ScopeEngineDeps {
  now?: () => number;
  /** When provided, every check writes security.scope.allowed / .denied. */
  audit?: EngagementAuditSink;
}

export interface ScopeEngine {
  readonly engagement: Engagement | null;
  check(action: ScopeAction): ScopeCheckOutcome;
}

export function actionDigest(action: ScopeAction): string {
  return createHash("sha256")
    .update(canonicalJson({ tool: action.tool, targets: action.targets }), "utf8")
    .digest("hex");
}

export function createScopeEngine(
  engagement: Engagement | null,
  deps: ScopeEngineDeps = {},
): ScopeEngine {
  const now = deps.now ?? Date.now;

  const auditRow = (
    allowed: boolean,
    action: ScopeAction,
    digest: string,
    outcome: ScopeCheckResult,
  ): void => {
    deps.audit?.({
      actor: "system:security",
      action: allowed ? "security.scope.allowed" : "security.scope.denied",
      payload: {
        engagement_id: engagement?.id ?? null,
        action_digest: digest,
        tool: action.tool,
        targets: action.targets,
        reason: outcome.reason,
        ...(outcome.matched !== undefined ? { matched: outcome.matched } : {}),
      },
    });
  };

  return {
    engagement,
    check(action: ScopeAction): ScopeCheckOutcome {
      const digest = actionDigest(action);

      if (engagement === null) {
        const reason = "no engagement declared for this session; security actions are denied";
        auditRow(false, action, digest, { allowed: false, reason });
        return { decision: "deny", reason, action_digest: digest };
      }

      if (action.targets.length === 0) {
        const reason = "action declares no targets — nothing to authorize, denied";
        auditRow(false, action, digest, { allowed: false, reason });
        return { decision: "deny", reason, action_digest: digest };
      }

      const meta = securityToolMeta(action.tool);
      if (meta !== undefined && !(engagement.techniques ?? []).includes(meta.technique)) {
        const reason =
          `technique "${meta.technique}" (tool ${action.tool}) is not authorized by ` +
          `engagement ${engagement.id}`;
        auditRow(false, action, digest, { allowed: false, reason });
        return { decision: "deny", reason, action_digest: digest };
      }

      let matched: string | undefined;
      for (const target of action.targets) {
        const verdict = checkTarget(engagement, target, now());
        if (!verdict.allowed) {
          auditRow(false, action, digest, verdict);
          return { decision: "deny", reason: verdict.reason, action_digest: digest };
        }
        if (matched === undefined && verdict.matched !== undefined) {
          matched = verdict.matched;
        }
      }

      const outcome: ScopeCheckResult = {
        allowed: true,
        reason: "action targets in engagement scope",
        ...(matched !== undefined ? { matched } : {}),
      };
      auditRow(true, action, digest, outcome);
      return {
        decision: "allow",
        reason: outcome.reason,
        action_digest: digest,
        ...(matched !== undefined ? { matched } : {}),
      };
    },
  };
}
