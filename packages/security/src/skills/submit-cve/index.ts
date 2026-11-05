// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.3 §4.2 — MITRE CVE request form content — R4, never an automatic submission.

import { z } from "zod";
import { createHash } from "node:crypto";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import type { FindingStore } from "../../findings/store.js";
import type { SecurityToolMeta } from "../../scope/tool_filter.js";
import type { SecurityToolDeps } from "../../tools/shared.js";
import { assertWorkspacePath } from "../../tools/shared.js";

export const SUBMIT_META: SecurityToolMeta = {
  technique: "vulnerability_scanning",
  rate_class: "cve",
  unit: "requests",
};

export const submitCveInput = z
  .object({
    finding_id: z.string().min(1).max(128),
    /** The disclosure package directory (prepare-disclosure output). */
    package_dir: z.string().min(1).max(512),
    /** Researcher contact for the request form. */
    researcher_contact: z.string().min(3).max(320),
  })
  .strict();

const SUBMIT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    finding_id: { type: "string", description: "The finding being submitted." },
    package_dir: {
      type: "string",
      description: "The disclosures/<finding-id> directory from security.prepare-disclosure.",
    },
    researcher_contact: {
      type: "string",
      description: "The researcher contact for the CVE request form.",
    },
  },
  required: ["finding_id", "package_dir", "researcher_contact"],
  additionalProperties: false,
} as const;

export function submitCveDefinition(): ToolDefinition {
  return {
    name: "security.submit-cve",
    description:
      "Produce the MITRE CVE request form content from a disclosure package (CNA fields: affected product/versions, attack vector, impact, repro, references). R4: every call stops for the owner's approval BEFORE any content is produced. The output is prefilled form content the operator reviews and submits by hand — there is no automatic submission path in this codebase, by design (a CVE request is a signed attestation).",
    input_schema: SUBMIT_INPUT_SCHEMA,
    risk: "R4",
    capabilities: [], // local content production; no network code exists here
    handler: "builtin:security.submit-cve",
    timeout_ms: 60_000,
  };
}

export function submitCveHandler(deps: SecurityToolDeps & { store: FindingStore }): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = submitCveInput.parse(call.input);
      const finding = await deps.store.get(input.finding_id);
      if (finding === null) {
        throw Object.assign(new Error(`finding ${input.finding_id} not found`), {
          name: "SecurityToolError",
          code: "skill.error" as const,
        });
      }
      if (ctx.engagement === null || ctx.engagement.id !== finding.engagement_id) {
        throw Object.assign(
          new Error(
            `finding ${input.finding_id} belongs to engagement ${finding.engagement_id}, not this session's — cross-engagement tooling is denied`,
          ),
          { name: "SecurityToolError", code: "skill.error" as const },
        );
      }
      // R3-1/R3-7: the package is VERIFIED, not trusted. Three gates:
      //   (1) the manifest binds to THIS finding (manifest.finding_id),
      //   (2) the on-disk manifest hash equals the hash prepare-disclosure
      //       recorded on the finding row (the durable, model-unreachable
      //       record — the model can fs.write the workspace, not the row),
      //   (3) EVERY package file's content hash equals its manifest entry.
      const dir = assertWorkspacePath(ctx, input.package_dir, "package_dir");
      let manifestRaw: string;
      try {
        manifestRaw = (await ctx.sandbox.readFile(`${dir}/package.json`)).toString("utf8");
      } catch {
        throw Object.assign(
          new Error(
            `${dir}/package.json not found — run security.prepare-disclosure first; ` +
              "submit-cve only works from a prepared package",
          ),
          { name: "SecurityToolError", code: "skill.error" as const },
        );
      }
      const manifestHash = createHash("sha256").update(manifestRaw).digest("hex");
      let manifest: {
        finding_id?: string;
        title?: string;
        affected_versions?: string[];
        files?: Array<{ name: string; sha256: string; bytes: number }>;
      };
      try {
        manifest = JSON.parse(manifestRaw) as typeof manifest;
      } catch (err) {
        throw Object.assign(
          new Error(`package manifest is not valid JSON: ${(err as Error).message}`),
          { name: "SecurityToolError", code: "skill.error" as const },
        );
      }
      // (1) binding: the package belongs to THIS finding.
      if (manifest.finding_id !== finding.id) {
        throw Object.assign(
          new Error(
            `package ${dir} belongs to finding ${manifest.finding_id ?? "(none)"}, not ${finding.id} — cross-finding packages are refused`,
          ),
          { name: "SecurityToolError", code: "skill.error" as const },
        );
      }
      // (2) the recorded hash: prepare-disclosure stamped it on the finding.
      const recorded = /disclosure-package: .*sha256=([0-9a-f]{64})/.exec(finding.notes);
      if (recorded === null) {
        throw Object.assign(
          new Error(
            `finding ${finding.id} carries no recorded package hash — the package was not prepared through security.prepare-disclosure`,
          ),
          { name: "SecurityToolError", code: "skill.error" as const },
        );
      }
      if (recorded[1] !== manifestHash) {
        throw Object.assign(
          new Error(
            `package manifest hash mismatch: on disk ${manifestHash.slice(0, 16)}…, recorded ${recorded[1]!.slice(0, 16)}… — ` +
              "the package was modified after preparation; re-run security.prepare-disclosure",
          ),
          { name: "SecurityToolError", code: "skill.error" as const },
        );
      }
      // (3) per-file verification: every entry's content hash matches disk.
      for (const entry of manifest.files ?? []) {
        let content: Buffer;
        try {
          content = await ctx.sandbox.readFile(`${dir}/${entry.name}`);
        } catch {
          throw Object.assign(
            new Error(
              `package file ${dir}/${entry.name} is missing (manifest lists it) — tampered package`,
            ),
            { name: "SecurityToolError", code: "skill.error" as const },
          );
        }
        const actual = createHash("sha256").update(content).digest("hex");
        if (actual !== entry.sha256) {
          throw Object.assign(
            new Error(
              `package file ${entry.name} hash mismatch: on disk ${actual.slice(0, 16)}…, manifest ${entry.sha256.slice(0, 16)}… — ` +
                "the package was modified after preparation; re-run security.prepare-disclosure",
            ),
            { name: "SecurityToolError", code: "skill.error" as const },
          );
        }
      }
      // R3-6: the PRODUCT is the correlated product recorded on the finding,
      // never the engagement's target host (client infrastructure).
      const productMatch = /correlated-product: (.+)/.exec(finding.notes);
      const product =
        productMatch !== null
          ? productMatch[1]!.trim()
          : "(unknown — run security.correlate-cve with the affected product first)";

      // The MITRE CVE request form content (the CNA submission fields).
      const form = [
        "# MITRE CVE Request — form content (submit manually at",
        "# https://cveform.mitre.org/ — this tool never submits)",
        "",
        `REQUEST TYPE: Request a CVE ID`,
        `PRODUCT: ${product}`,
        `AFFECTED VERSIONS: ${(manifest.affected_versions ?? []).join(", ")}`,
        `VULNERABILITY TYPE: ${finding.title}`,
        `ATTACK VECTOR: ${finding.severity === "critical" || finding.severity === "high" ? "network / low privileges" : "(describe from the finding)"}`,
        `IMPACT: see disclosures/${finding.id}/impact.md`,
        `HOW TO REPRODUCE: see disclosures/${finding.id}/reproduction.md (hash-verified)`,
        `REFERENCES:`,
        `  - package manifest sha256 ${manifestHash}`,
        ...(finding.cve ?? []).map((c) => `  - correlated: ${c}`),
        `RESEARCHER CONTACT: ${input.researcher_contact}`,
        `VENDOR CONTACT: ${ctx.engagement.emergency_contact ?? "(from the disclosure package)"}`,
        "",
        `NOTES: This is a MINIMUM demonstration reproduction; the disclosure package`,
        `at disclosures/${finding.id}/ carries the hash-verified evidence chain.`,
      ].join("\n");
      const formPath = `disclosures/${finding.id}/cve-request.md`;
      await ctx.sandbox.writeFile(formPath, form);
      deps.audit?.({
        actor: "system:security",
        action: "security.cve.request_prepared",
        payload: {
          session_id: ctx.session_id,
          engagement_id: ctx.engagement.id,
          finding_id: finding.id,
          manifest_sha256: manifestHash,
          form: formPath,
          note: "R4-approved content production; submission is a manual operator step",
        },
      });
      return {
        kind: "json",
        json: {
          finding_id: finding.id,
          form_path: formPath,
          form,
          manifest_sha256: manifestHash,
          next_step:
            "review cve-request.md and submit at https://cveform.mitre.org/ — " +
            "submission is yours, not the harness's",
        },
      };
    },
  };
}
