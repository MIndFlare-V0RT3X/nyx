// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy engine and approval lifecycle contracts. Deny-first: `deny > ask >
// allow`. Structural invariants are immutable — no config, plugin, or model
// output can weaken them.

import type { Capability, RiskTier } from "./tools.js";

export type Decision = "allow" | "ask" | "deny";

export interface PolicyRule {
  id: string;
  match: {
    tool?: string | string[];
    capability?: Capability | Capability[];
    risk?: RiskTier | RiskTier[];
    path_prefix?: string;
    host?: string;
    owner_only?: boolean;
  };
  decision: Decision;
  reason?: string;
  /** Structural invariant — cannot be overridden by config. */
  immutable?: boolean;
}

export interface ActionRequest {
  session_id: string;
  turn_id: string;
  tool: string;
  input: unknown;
  risk: RiskTier;
  capabilities: Capability[];
  actor_id: string;
}

export interface PolicyVerdict {
  decision: Decision;
  rule_id: string;
  /** sha256 over canonical JSON of {tool, input, risk} — the exact-action binding. */
  action_digest: string;
  /** Human-readable, bound to this exact action. */
  summary: string;
}

export interface PolicyEngine {
  evaluate(req: ActionRequest): Promise<PolicyVerdict>;
}

export interface ApprovalContext {
  session_id: string;
  turn_id: string;
  actor_id: string;
}

export interface ApprovalRecord {
  id: string;
  session_id: string;
  turn_id: string;
  action_digest: string;
  summary: string;
  risk: RiskTier;
  decision: "pending" | "allow" | "deny";
  decided_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

/**
 * Approval lifecycle. `request` blocks until the approval is resolved or
 * expired (expiry resolves as deny). Approvals are single-use and expire
 * 10 minutes after creation.
 */
export interface ApprovalEngine {
  request(v: PolicyVerdict, ctx: ApprovalContext): Promise<"allow" | "deny">;
  resolve(id: string, decision: "allow" | "deny", decided_by: string): Promise<ApprovalRecord>;
  get(id: string): Promise<ApprovalRecord | null>;
  pending(session_id: string): Promise<ApprovalRecord[]>;
  /** Exact-action binding: consume a resolved approval for a digest. Throws on mismatch/expiry/reuse. */
  consume(id: string, action_digest: string): Promise<ApprovalRecord>;
  /**
   * Withdraw every pending approval of a session (resolving each deny with
   * decided_by "system:withdrawn" and its audit row). Optional: implemented
   * by ApprovalEngineImpl since 2.0.2. Abort paths call it so a turn being
   * torn down does not leave a request() blocked until its TTL — a caller
   * that lacks it simply keeps the pre-2.0.2 behavior.
   */
  withdrawSession?(session_id: string, reason: string): number | void;
}
