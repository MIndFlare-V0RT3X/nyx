// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.3 §4.2 — the disclosure-workflow registration: four tools, one pipeline (correlate → minimize → prepare → R4 submit).

import type { ToolDefinition, ToolHandler, ToolRegistry } from "@nyx/protocol";
import type { FindingStore } from "../findings/store.js";
import { registerSecurityToolMeta } from "../scope/tool_filter.js";
import type { SecurityToolMeta } from "../scope/tool_filter.js";
import type { SecurityToolDeps } from "../tools/shared.js";
import type { JsonFetch } from "./cve_services.js";
import {
  CORRELATE_META,
  correlateCveDefinition,
  correlateCveHandler,
} from "./correlate-cve/index.js";
import { MINIMIZE_META, minimizePocDefinition, minimizePocHandler } from "./minimize-poc/index.js";
import {
  PREPARE_META,
  prepareDisclosureDefinition,
  prepareDisclosureHandler,
} from "./prepare-disclosure/index.js";
import { SUBMIT_META, submitCveDefinition, submitCveHandler } from "./submit-cve/index.js";

export interface RegisterDisclosureToolsDeps extends SecurityToolDeps {
  store: FindingStore;
  /** Injectable CVE-service fetch (tests). */
  fetchImpl?: JsonFetch;
}

export function registerDisclosureTools(
  registry: ToolRegistry,
  deps: RegisterDisclosureToolsDeps,
): void {
  const registrations: Array<{
    def: () => ToolDefinition;
    handler: () => ToolHandler;
    meta: { name: string; meta: SecurityToolMeta };
  }> = [
    {
      def: correlateCveDefinition,
      handler: () => correlateCveHandler(deps),
      meta: { name: "security.correlate-cve", meta: CORRELATE_META },
    },
    {
      def: minimizePocDefinition,
      handler: () => minimizePocHandler(deps),
      meta: { name: "security.minimize-poc", meta: MINIMIZE_META },
    },
    {
      def: prepareDisclosureDefinition,
      handler: () => prepareDisclosureHandler(deps),
      meta: { name: "security.prepare-disclosure", meta: PREPARE_META },
    },
    {
      def: submitCveDefinition,
      handler: () => submitCveHandler(deps),
      meta: { name: "security.submit-cve", meta: SUBMIT_META },
    },
  ];
  for (const r of registrations) {
    registry.register(r.def(), r.handler());
    registerSecurityToolMeta(r.meta.name, r.meta.meta);
  }
}
