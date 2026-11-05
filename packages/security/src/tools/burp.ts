// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.2 §3.2 — Burp Suite integration.
//
// Design (docs/EXPLOITATION.md has the full rationale): Burp Community is a
// GUI application the OPERATOR drives manually on the workstation. Running
// it inside a headless container would require an X11 socket mount — the
// exact fd-leak bypass the Phase 6.1 bypass suite forbids — and Community
// has no REST API (a Pro feature; the brief's "via Burp's REST API" is
// noted as a deviation). What NYX provides instead is the honest version of
// "the sandbox it runs in": the egress proxy IS Burp's sandbox —
//
//   wiring:  the exact upstream-proxy settings for the operator's Burp, so
//            every request Burp makes is scope-gated exactly like sandbox
//            traffic (same listeners, same audit rows, same rate buckets).
//   capture: parse a Burp XML history export ("Save items") from the
//            workspace: in-scope entries become structured records with a
//            hash-verified artifact; out-of-scope entries are listed, never
//            included — the capture cannot launder unauthorized traffic.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import { checkUrl } from "../engagement/matcher.js";
import type { SecurityToolMeta } from "../scope/tool_filter.js";
import type { SecurityToolDeps } from "./shared.js";
import { assertWorkspacePath } from "./shared.js";

export const BURP_META: SecurityToolMeta = {
  technique: "exploitation",
  rate_class: "burp",
  unit: "requests",
};

const WORKSPACE_FILE = /^[A-Za-z0-9._\-/]+$/;

export const burpInput = z
  .object({
    action: z.enum(["wiring", "capture"]),
    /** capture: the Burp XML export inside the workspace. */
    file: z
      .string()
      .min(1)
      .max(512)
      .regex(WORKSPACE_FILE, "workspace export path")
      .refine((p) => !p.split("/").includes(".."), "file must contain no .. segments")
      .optional(),
  })
  .strict()
  .refine((i) => i.action !== "capture" || i.file !== undefined, {
    message: "action 'capture' requires 'file'",
    path: ["file"],
  });

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["wiring", "capture"], description: "Get the upstream-proxy wiring, or capture a Burp XML history export." },
    file: { type: "string", description: "capture: workspace-relative Burp 'Save items' XML export." },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

export function burpDefinition(): ToolDefinition {
  return {
    name: "security.burp",
    description:
      "Burp Suite integration for manual testing: 'wiring' returns the upstream-proxy settings that put the operator's Burp behind the engagement's egress gate (every request scope-checked and rate-limited like sandbox traffic); 'capture' parses a Burp XML history export from the workspace — in-scope entries become hash-verified evidence records, out-of-scope entries are listed and excluded.",
    input_schema: INPUT_SCHEMA,
    risk: "R2",
    capabilities: [], // wiring returns settings; capture reads a workspace file
    handler: "builtin:security.burp",
    timeout_ms: 120_000,
  };
}

export interface BurpHistoryItem {
  url: string;
  host: string;
  ip: string | null;
  port: number | null;
  protocol: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  responselength: number | null;
  mimetype: string | null;
}

function decodeCdata(raw: string): string {
  const m = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(raw);
  return m !== null ? (m[1] ?? "") : raw;
}

/**
 * Parse Burp's XML "Save items" export (real format — fixtures/burp-
 * history.xml): flat <item> entries with CDATA'd url/path and optional
 * base64 request/response bodies (not captured here — the history metadata
 * and the artifact hash are the evidence).
 */
export function parseBurpXml(xml: string): BurpHistoryItem[] {
  const items: BurpHistoryItem[] = [];
  const blocks = xml.split(/<item>/).slice(1);
  for (const block of blocks) {
    const body = block.split("</item>")[0] ?? "";
    const pick = (tag: string): string | null => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(body);
      return m !== null ? m[1]?.trim() ?? null : null;
    };
    const hostTag = /<host\s+ip="([^"]*)"[^>]*>([\s\S]*?)<\/host>/.exec(body);
    const statusText = pick("status");
    const portText = pick("port");
    const lenText = pick("responselength");
    const url = pick("url");
    if (url === null) continue;
    items.push({
      url: decodeCdata(url),
      host: hostTag !== null ? decodeCdata(hostTag[2] ?? "") : (pick("host") ?? ""),
      ip: hostTag !== null && hostTag[1] !== undefined && hostTag[1] !== "" ? hostTag[1] : null,
      port: portText !== null && /^\d+$/.test(portText) ? Number(portText) : null,
      protocol: pick("protocol"),
      method: pick("method"),
      path: pick("path") !== null ? decodeCdata(pick("path")!) : null,
      status: statusText !== null && /^\d+$/.test(statusText) ? Number(statusText) : null,
      responselength:
        lenText !== null && /^\d+$/.test(lenText) ? Number(lenText) : null,
      mimetype: pick("mimetype"),
    });
  }
  return items;
}

export function burpHandler(deps: SecurityToolDeps): ToolHandler {
  void deps;
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = burpInput.parse(call.input);

      if (input.action === "wiring") {
        if (ctx.engagement === null) {
          return {
            kind: "text",
            text: "denied by scope: no engagement declared for this session; security tools are denied",
          };
        }
        const egress = ctx.sandbox?.egress;
        if (egress === undefined) {
          throw Object.assign(
            new Error(
              "this session's sandbox is not egress-proxied (no engagement network). Burp wiring " +
                "requires an egress-proxied session — see docs/EGRESS-PROXY.md and docs/EXPLOITATION.md",
            ),
            { name: "SecurityToolError", code: "skill.error" as const },
          );
        }
        const port = egress.portFor("burp");
        const defaultPort = egress.portFor(null);
        return {
          kind: "json",
          json: {
            note:
              "Burp Suite runs on the operator's workstation. Set Burp's User options → Connections → " +
              "Upstream Proxy Servers to the host:port below (the engagement's egress gate): every " +
              "request Burp makes is then scope-checked, rate-limited, and audit-logged exactly like " +
              "sandbox traffic. Export the history (Proxy → HTTP history → Save items) into the " +
              "session workspace and run security.burp with action=capture.",
            upstream_proxy_host: egress.gateway,
            upstream_proxy_port: port,
            upstream_proxy_default_port: defaultPort,
            no_proxy: "localhost,127.0.0.1,::1",
            engagement_id: ctx.engagement.id,
          },
        };
      }

      // capture — the runtime rewrites `file` to absolute-under-workdir; the
      // guard re-refuses escapes for direct handler calls, then normalizes.
      const file = assertWorkspacePath(ctx, input.file!, "file");
      const xml = (await ctx.sandbox.readFile(file)).toString("utf8");
      const items = parseBurpXml(xml);
      if (items.length === 0) {
        throw Object.assign(
          new Error(`no <item> entries parsed from ${input.file} — is it a Burp "Save items" XML export?`),
          { name: "SecurityToolError", "code": "skill.error" as const },
        );
      }
      const engagement = ctx.engagement;
      const inScope: Array<BurpHistoryItem & { verdict_matched?: string }> = [];
      const outOfScope: Array<{ url: string; reason: string }> = [];
      for (const item of items) {
        if (engagement === null) {
          outOfScope.push({ url: item.url, reason: "no engagement declared" });
          continue;
        }
        const verdict = checkUrl(engagement, item.url);
        if (verdict.allowed) {
          inScope.push({ ...item, ...(verdict.matched !== undefined ? { verdict_matched: verdict.matched } : {}) });
        } else {
          outOfScope.push({ url: item.url, reason: verdict.reason });
        }
      }
      // The capture artifact: the parsed, scope-filtered records (the raw
      // export stays where the operator put it; THIS artifact is what a
      // finding cites).
      const capture = {
        source: file,
        captured_at: new Date().toISOString(),
        engagement_id: engagement?.id ?? null,
        in_scope: inScope,
        out_of_scope: outOfScope,
      };
      const json = JSON.stringify(capture, null, 2);
      const path = `artifacts/burp-capture-${Date.now()}.json`;
      await ctx.sandbox.writeFile(path, json);
      const hash = createHash("sha256").update(json).digest("hex");
      return {
        kind: "json",
        json: {
          in_scope_count: inScope.length,
          out_of_scope_count: outOfScope.length,
          out_of_scope: outOfScope.map((o) => o.url),
          records: inScope,
          artifact: { path, sha256: hash },
        },
      };
    },
  };
}
