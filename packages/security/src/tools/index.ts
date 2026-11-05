// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §3 — registerSecurityTools: puts the six security tools on a
// ToolRegistry AND registers their technique metadata with the structural
// filter. Registration order does not matter; the engagement view (5.2's
// buildEngagementTooling) filters by technique at session scope.

import type { ToolDefinition, ToolHandler, ToolRegistry } from "@nyx/protocol";
import { DnsEgressResolver } from "@nyx/tools";
import type { EgressResolver } from "@nyx/tools";
import { registerSecurityToolMeta } from "../scope/tool_filter.js";
import { SecurityRateLimiter } from "../scope/rate_limiter.js";
import type { EngagementAuditSink } from "../engagement/loader.js";
import type { FindingStore } from "../findings/store.js";
import type { SecurityExecutor } from "./executor.js";
import type { SecurityToolDeps } from "./shared.js";
import { SUBFINDER_META, subfinderDefinition, subfinderHandler } from "./subfinder.js";
import { HTTPX_META, httpxDefinition, httpxHandler } from "./httpx.js";
import { NUCLEI_META, nucleiDefinition, nucleiHandler } from "./nuclei.js";
import { FFUF_META, ffufDefinition, ffufHandler } from "./ffuf.js";
import { KATANA_META, katanaDefinition, katanaHandler } from "./katana.js";
import { NMAP_META, nmapDefinition, nmapHandler } from "./nmap.js";
import {
  SQLMAP_EXPLOIT_META,
  SQLMAP_SCAN_META,
  sqlmapExploitDefinition,
  sqlmapExploitHandler,
  sqlmapScanDefinition,
  sqlmapScanHandler,
} from "./sqlmap.js";
import {
  NUCLEI_TEMPLATE_META,
  nucleiTemplateDefinition,
  nucleiTemplateHandler,
} from "./nuclei_template.js";
import {
  MSF_RUN_META,
  MSF_SEARCH_META,
  msfRunDefinition,
  msfRunHandler,
  msfSearchDefinition,
  msfSearchHandler,
} from "./msf.js";
import { BURP_META, burpDefinition, burpHandler } from "./burp.js";

export interface RegisterSecurityToolsDeps {
  /** The findings store over the shared nyx.db handle. */
  store: FindingStore;
  /** Injected executor (tests). When absent, resolved per call. */
  executor?: SecurityExecutor;
  /** With no injected executor: run the binaries in the session sandbox
   * (config security.executor: "sandbox"). */
  use_sandbox_executor?: boolean;
  /** Shared process rate limiter (one per process is correct — buckets are
   * keyed by engagement id, class, and host). */
  limiter?: SecurityRateLimiter;
  /** Pinned-resolution seam (tests inject a fake DNS). */
  resolver?: EgressResolver;
  now?: () => number;
  /** The audit sink (approval engine handle's audit fn). */
  audit?: EngagementAuditSink;
}

export function registerSecurityTools(
  registry: ToolRegistry,
  deps: RegisterSecurityToolsDeps,
): void {
  const shared: SecurityToolDeps = {
    resolver: deps.resolver ?? new DnsEgressResolver(),
    limiter: deps.limiter ?? new SecurityRateLimiter(),
    ...(deps.executor !== undefined ? { executor: deps.executor } : {}),
    ...(deps.use_sandbox_executor === true ? { use_sandbox_executor: true } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.audit !== undefined ? { audit: deps.audit } : {}),
  };

  const registrations: Array<{
    def: () => ToolDefinition;
    handler: () => ToolHandler;
    meta: { name: string; meta: typeof SUBFINDER_META };
  }> = [
    { def: subfinderDefinition, handler: () => subfinderHandler(shared), meta: { name: "security.subfinder", meta: SUBFINDER_META } },
    { def: httpxDefinition, handler: () => httpxHandler(shared), meta: { name: "security.httpx", meta: HTTPX_META } },
    { def: nucleiDefinition, handler: () => nucleiHandler({ ...shared, store: deps.store }), meta: { name: "security.nuclei", meta: NUCLEI_META } },
    { def: ffufDefinition, handler: () => ffufHandler(shared), meta: { name: "security.ffuf", meta: FFUF_META } },
    { def: katanaDefinition, handler: () => katanaHandler(shared), meta: { name: "security.katana", meta: KATANA_META } },
    { def: nmapDefinition, handler: () => nmapHandler(shared), meta: { name: "security.nmap", meta: NMAP_META } },
    // Phase 6.2 — the exploitation toolkit (docs/EXPLOITATION.md).
    { def: sqlmapScanDefinition, handler: () => sqlmapScanHandler({ ...shared, store: deps.store }), meta: { name: "security.sqlmap-scan", meta: SQLMAP_SCAN_META } },
    { def: sqlmapExploitDefinition, handler: () => sqlmapExploitHandler(shared), meta: { name: "security.sqlmap-exploit", meta: SQLMAP_EXPLOIT_META } },
    { def: nucleiTemplateDefinition, handler: () => nucleiTemplateHandler({ ...shared, store: deps.store }), meta: { name: "security.nuclei-template", meta: NUCLEI_TEMPLATE_META } },
    { def: msfSearchDefinition, handler: () => msfSearchHandler(shared), meta: { name: "security.msf-search", meta: MSF_SEARCH_META } },
    { def: msfRunDefinition, handler: () => msfRunHandler(shared), meta: { name: "security.msf-run", meta: MSF_RUN_META } },
    { def: burpDefinition, handler: () => burpHandler(shared), meta: { name: "security.burp", meta: BURP_META } },
  ];

  for (const r of registrations) {
    registry.register(r.def(), r.handler());
    registerSecurityToolMeta(r.meta.name, r.meta.meta);
  }
}

export { FakeSecurityExecutor, HostSecurityExecutor, SandboxSecurityExecutor, assertSafeTokens, SecurityToolError } from "./executor.js";
export type { SecurityExecutor, ExecutorResult } from "./executor.js";
export type { SecurityToolDeps } from "./shared.js";
export { runSecurityTool, parseJsonl } from "./shared.js";
