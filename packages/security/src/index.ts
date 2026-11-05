// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/security — the Phase 5 security subsystem for authorized engagements.
//
// Layered on the Phase 1 scope foundation (@nyx/scope + the protocol
// Engagement contract):
//   - engagement/ — the operator's signed engagement FILE (schema, loader,
//     matcher surface). A file that fails validation never becomes a
//     session's scope; the loaded snapshot is immutable for the session's
//     lifetime and pinned by content hash.
//   - scope/ — the technique-gated tool filter, the action-time scope check
//     with audit rows, and the token-bucket rate limiter (Phase 5 §1.3/§1.5).
//   - findings/ — the findings store (nyx.db, FTS) and CVSS scoring.
//   - reports/ — Markdown + self-contained HTML generation with the
//     out-of-scope finding gate.
//   - tools/ — the security tool wrappers (subfinder, httpx, nuclei, ffuf,
//     katana, nmap): every network action routes through the checked egress
//     path; a tool whose technique is not in the engagement is structurally
//     absent from the registry, not runtime-gated.
//
// This package makes "authorized" structural: scope is the precondition for
// a security tool existing in a session at all.

export {
  SecurityEngagementFileSchema,
  fileToEngagement,
  ENGAGEMENT_SCHEMA_VERSION,
  type SecurityEngagementFile,
} from "./engagement/schema.js";
export {
  loadEngagementYaml,
  ENGAGEMENT_LOADED_AUDIT_ACTION,
  EngagementFileError,
  type LoadedEngagement,
  type LoadEngagementDeps,
  type EngagementAuditSink,
} from "./engagement/loader.js";
export { checkUrl, parseActionUrl, type ParsedActionUrl } from "./engagement/matcher.js";
export {
  checkTarget,
  checkResolvedTarget,
  makeScopeChecker,
  validateTargets,
  engagementSummary,
  parseUrlTarget,
} from "./engagement/matcher.js";

// ── scope engine (Phase 5 §1.3/§1.5) ────────────────────────────────────────
export {
  createScopeEngine,
  actionDigest,
  type ScopeAction,
  type ScopeCheckOutcome,
  type ScopeEngine,
  type ScopeEngineDeps,
} from "./scope/engine.js";
export {
  registerSecurityToolMeta,
  clearSecurityToolMeta,
  securityToolMeta,
  isSecurityTool,
  engagementToolAllowlist,
  EngagementToolRegistry,
  EngagementKernelView,
  buildEngagementTooling,
  type SecurityToolMeta,
} from "./scope/tool_filter.js";
export {
  SecurityRateLimiter,
  type RateLimiterDeps,
  type RateTarget,
  type RateBucketStore,
} from "./scope/rate_limiter.js";
export { SqliteRateBucketStore, type SqliteRateBucketStoreDeps } from "./scope/rate_store.js";
// Phase 6.1 — the egress proxy policy + binder (docs/EGRESS-PROXY.md).
export {
  createEgressPolicy,
  createEgressBinder,
  type EgressPolicyDeps,
  type EgressBinderOptions,
} from "./scope/egress_policy.js";

// ── findings (Phase 5 §2.2) ─────────────────────────────────────────────────
export {
  severityRank,
  severityFromScore,
  cvssSeverityLabel,
  compareFindingsForReport,
  type Finding,
  type FindingSeverity,
  type FindingStatus,
  type FindingEvidence,
  type FindingTarget,
  type FindingSessionBinding,
} from "./findings/schema.js";
export {
  FindingStore,
  FindingStoreError,
  orderFindingsForReport,
  type FindingStoreDeps,
  type FindingListOptions,
} from "./findings/store.js";
export {
  scoreCvss3,
  scoreCvss3Vector,
  parseCvss3,
  Cvss3Error,
  type Cvss3Metrics,
} from "./findings/cvss3.js";
export { scoreCvss4, Cvss4Vector, Cvss4Error } from "./findings/cvss4.js";

// ── reports (Phase 5 §2.3) ──────────────────────────────────────────────────
export {
  generateReport,
  assertFindingsInScope,
  OutOfScopeFindingError,
  type ReportInput,
  type RenderedReport,
} from "./reports/generator.js";
export { verifyEvidence, EvidenceError, type VerifiedEvidence } from "./reports/evidence.js";

// ── security tools (Phase 5 §3) ──────────────────────────────────────────────
export {
  registerSecurityTools,
  FakeSecurityExecutor,
  HostSecurityExecutor,
  SandboxSecurityExecutor,
  assertSafeTokens,
  SecurityToolError,
  type SecurityExecutor,
  type ExecutorResult,
  type RegisterSecurityToolsDeps,
  type SecurityToolDeps,
} from "./tools/index.js";
