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
export {
  checkUrl,
  parseActionUrl,
  type ParsedActionUrl,
} from "./engagement/matcher.js";
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
export { SecurityRateLimiter, type RateLimiterDeps, type RateTarget } from "./scope/rate_limiter.js";
