// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/policy — deny-first policy engine, approval lifecycle, and
// hash-chained audit log.

export { PolicyEngineImpl, computeActionDigest } from "./policy.js";
export type { PolicyEngineOptions } from "./policy.js";
export {
  ApprovalEngineImpl,
  ensureApprovalEngineTables,
  openApprovalEngine,
} from "./approvals.js";
export type { ApprovalEngineOptions } from "./approvals.js";
export { appendAudit, ensureAuditTable, verifyAuditChain } from "./audit.js";
export type { AuditEntry, AuditVerifyResult } from "./audit.js";
export {
  appendEventAudit,
  isAuditableEvent,
  reconcileEventAudit,
} from "./event-audit.js";
export type { AuditableEvent, AuditableEventType } from "./event-audit.js";
export {
  EngagementOwnershipError,
  assertEngagementOwnership,
} from "./ownership.js";
export {
  auditEngagementCreated,
  isDomainOnlyEngagement,
} from "./engagement-audit.js";
export type {
  DnsResolver,
  EngagementAuditDeps,
  EngagementCreatedInput,
  ResolvedAddress,
} from "./engagement-audit.js";
export { policyRuleSchema } from "./schema.js";
export type { PolicyRuleSchema, SafeParseResult } from "./schema.js";
