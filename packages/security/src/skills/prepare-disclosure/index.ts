// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.3 §4.2 — the coordinated-disclosure package: repro, impact, versions, timeline, email draft — hashed.

import { z } from "zod";
import { createHash } from "node:crypto";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import type { FindingStore } from "../../findings/store.js";
import type { SecurityToolMeta } from "../../scope/tool_filter.js";
import type { SecurityToolDeps } from "../../tools/shared.js";

export const PREPARE_META: SecurityToolMeta = {
  technique: "vulnerability_scanning",
  rate_class: "cve",
  unit: "requests",
};

export const prepareDisclosureInput = z
  .object({
    finding_id: z.string().min(1).max(128),
    /** Affected versions (from the finding or the operator). */
    affected_versions: z.array(z.string().min(1).max(128)).min(1).max(32),
    /** Coordinated disclosure window, days. Default 90 (industry standard). */
    timeline_days: z.number().int().min(14).max(365).optional(),
    /** The vendor's security contact (from the engagement's emergency channel
     *  or the operator). Required for the notification email draft. */
    vendor_contact: z
      .string()
      .min(3)
      .max(320)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "an email address for the vendor security contact"),
    /** Free-form impact statement. */
    impact: z.string().min(1).max(8192),
  })
  .strict();

const PREPARE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    finding_id: { type: "string", description: "The finding being disclosed." },
    affected_versions: { type: "array", items: { type: "string" }, description: "Affected versions, e.g. ['2.4.49', '2.4.50']." },
    timeline_days: { type: "integer", minimum: 14, maximum: 365, description: "Coordinated disclosure window in days (default 90)." },
    vendor_contact: { type: "string", description: "The vendor security contact for the notification email." },
    impact: { type: "string", description: "Impact statement: what an attacker achieves." },
  },
  required: ["finding_id", "affected_versions", "vendor_contact", "impact"],
  additionalProperties: false,
} as const;

export function prepareDisclosureDefinition(): ToolDefinition {
  return {
    name: "security.prepare-disclosure",
    description:
      "Assemble the coordinated-disclosure package for a finding: reproduction, impact statement, affected versions, suggested CVSS, a 90-day timeline (configurable), and a draft vendor notification email — every file hash-recorded, the package manifest hashed into the audit chain, written to disclosures/<finding-id>/ in the session workspace.",
    input_schema: PREPARE_INPUT_SCHEMA,
    risk: "R2",
    capabilities: [], // local assembly
    handler: "builtin:security.prepare-disclosure",
    timeout_ms: 60_000,
  };
}

export function prepareDisclosureHandler(
  deps: SecurityToolDeps & { store: FindingStore },
): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = prepareDisclosureInput.parse(call.input);
      const finding = await deps.store.get(input.finding_id);
      if (finding === null) {
        throw Object.assign(new Error(`finding ${input.finding_id} not found`), {
          name: "SecurityToolError",
          code: "skill.error",
        });
      }
      if (ctx.engagement === null || ctx.engagement.id !== finding.engagement_id) {
        throw Object.assign(
          new Error(
            `finding ${input.finding_id} belongs to engagement ${finding.engagement_id}, not this session's — cross-engagement tooling is denied`,
          ),
          { name: "SecurityToolError", code: "skill.error" },
        );
      }
      // R3-13: withdrawn/unconfirmed findings do not enter the disclosure
      // pipeline — false positives and duplicates are not disclosed.
      if (finding.status === "false_positive" || finding.status === "duplicate") {
        throw Object.assign(
          new Error(
            `finding ${input.finding_id} is ${finding.status} — disclosure packages are only prepared for open/confirmed findings`,
          ),
          { name: "SecurityToolError", code: "skill.error" },
        );
      }
      const days = input.timeline_days ?? 90;
      const now = deps.now ?? Date.now;
      const plus = (n: number) => new Date(now() + n * 86_400_000).toISOString().slice(0, 10);

      const dir = `disclosures/${finding.id}`;
      const files: Array<{ name: string; content: string }> = [
        {
          name: "reproduction.md",
          content:
            `# Reproduction — ${finding.title}\n\n` +
            `Target: ${finding.target.host}${finding.target.port !== undefined ? `:${finding.target.port}` : ""}` +
            `${finding.target.path ?? ""}\n\n` +
            `${finding.reproduction}\n\n` +
            `Evidence artifacts (hash-verified):\n` +
            finding.evidence.map((e) => `- ${e.path} (sha256 ${e.hash})`).join("\n") +
            "\n",
        },
        {
          name: "impact.md",
          content: `# Impact\n\n${input.impact}\n\nSeverity: ${finding.severity}` +
            (finding.cvss_3_1 !== undefined ? `\nCVSS 3.1 base score: ${finding.cvss_3_1}` : "") +
            (finding.cvss_4_0 !== undefined ? `\nCVSS 4.0 base score: ${finding.cvss_4_0}` : "") +
            "\n",
        },
        {
          name: "versions.md",
          content:
            `# Affected versions\n\n${input.affected_versions.map((v) => `- ${v}`).join("\n")}\n`,
        },
        {
          name: "timeline.md",
          content:
            `# Coordinated disclosure timeline (${days} days)\n\n` +
            `- ${plus(0)}: notification prepared (send email.md — nothing has been sent yet)\n` +
            `- ${plus(Math.floor(days / 3))}: follow-up if no acknowledgment\n` +
            `- ${plus(days)}: coordinated public disclosure (or earlier by vendor request)\n`,
        },
        {
          name: "email.md",
          content:
            `To: ${input.vendor_contact}\n` +
            `Subject: Security issue: ${finding.title}\n\n` +
            `Hello,\n\n` +
            `We would like to report a security issue${finding.cve !== undefined && finding.cve.length > 0 ? ` (correlated: ${finding.cve.join(", ")})` : ""} ` +
            `affecting ${input.affected_versions.join(", ")}:\n\n` +
            `${finding.title}\n\n${input.impact}\n\n` +
            `Reproduction steps and hash-verified evidence are attached; we follow a ` +
            `${days}-day coordinated disclosure timeline and are happy to work with your ` +
            `schedule.\n\n` +
            `Regards,\n`,
        },
      ];
      const manifest: Record<string, unknown> = {
        finding_id: finding.id,
        engagement_id: ctx.engagement.id,
        title: finding.title,
        severity: finding.severity,
        affected_versions: input.affected_versions,
        timeline_days: days,
        prepared_at: new Date(now()).toISOString(),
        files: [] as Array<{ name: string; sha256: string; bytes: number }>,
      };
      for (const f of files) {
        await ctx.sandbox.writeFile(`${dir}/${f.name}`, f.content);
        (manifest.files as Array<{ name: string; sha256: string; bytes: number }>).push({
          name: f.name,
          sha256: createHash("sha256").update(f.content).digest("hex"),
          bytes: Buffer.byteLength(f.content),
        });
      }
      const manifestJson = JSON.stringify(manifest, null, 2);
      await ctx.sandbox.writeFile(`${dir}/package.json`, manifestJson);
      const packageHash = createHash("sha256").update(manifestJson).digest("hex");
      // R3-1: record the package hash on the FINDING — the finding row is
      // the durable, model-unreachable record; submit-cve verifies the
      // on-disk manifest against it (the audit sink is write-only).
      await deps.store.update(input.finding_id, {
        notes:
          (finding.notes.length > 0 ? `${finding.notes}\n` : "") +
          `disclosure-package: ${dir} sha256=${packageHash}`,
      });
      deps.audit?.({
        actor: "system:security",
        action: "security.disclosure.prepared",
        payload: {
          session_id: ctx.session_id,
          engagement_id: ctx.engagement.id,
          finding_id: finding.id,
          package: `${dir}/package.json`,
          sha256: packageHash,
        },
      });
      return {
        kind: "json",
        json: {
          directory: dir,
          manifest: `${dir}/package.json`,
          sha256: packageHash,
          files: manifest.files,
        },
      };
    },
  };
}

