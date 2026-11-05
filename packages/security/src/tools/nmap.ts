// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §3.1 — nmap: port scanning. Targets may be hosts or CIDR blocks;
// a CIDR target must be COVERED by an authorized CIDR and must not overlap
// any exclusion (structural containment, not a runtime spot check). Output
// is the open-port list (result data). Technique: port_scanning.
// Rate class counts PACKETS per second.

import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import { cidrContains, normalizeHost, parseCidr } from "@nyx/scope";
import type { SecurityToolMeta } from "../scope/tool_filter.js";
import { cooperativeRate, denied, runSecurityTool } from "./shared.js";
import type { SecurityToolDeps } from "./shared.js";

export const nmapInput = z
  .object({
    target: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[A-Za-z0-9.:\-/]+$/, "host or CIDR"),
    ports: z
      .string()
      .regex(/^[0-9,-]+$/, "port list like '80,443' or '1-1000'")
      .max(128)
      .optional(),
  })
  .strict();

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    target: {
      type: "string",
      pattern: "^[A-Za-z0-9.:\\-/]+$",
      description: "In-scope host or CIDR block to scan.",
    },
    ports: {
      type: "string",
      pattern: "^[0-9,\\-]+$",
      maxLength: 128,
      description: "Optional port list, e.g. '80,443' or '1-1000' (default: top 1000).",
    },
  },
  required: ["target"],
  additionalProperties: false,
} as const;

export const NMAP_META: SecurityToolMeta = {
  technique: "port_scanning",
  rate_class: "nmap",
  unit: "packets",
};

/** CIDR A covers CIDR I iff same family, A's prefix is shorter-or-equal, and
 * I's base address falls inside A. */
function cidrCovers(covering: string, inner: string): boolean {
  const a = parseCidr(covering);
  const i = parseCidr(inner);
  if (a === null || i === null || a.family !== i.family) return false;
  if (a.prefix > i.prefix) return false;
  return cidrContains(covering, inner.split("/")[0]!);
}

/** Two CIDRs overlap iff one covers the other. */
function cidrOverlap(a: string, b: string): boolean {
  return cidrCovers(a, b) || cidrCovers(b, a);
}

export function nmapDefinition(): ToolDefinition {
  return {
    name: "security.nmap",
    description:
      "Port scanning (service detection, top ports by default) of an in-scope host or CIDR. A CIDR target must be covered by an authorized CIDR and must not overlap any exclusion. Rate-limited through the engagement's nmap packets-per-second bucket. Returns the open-port list; findings are not created.",
    input_schema: INPUT_SCHEMA,
    risk: "R3",
    capabilities: ["net.egress"],
    handler: "builtin:security.nmap",
    timeout_ms: 900_000,
  };
}

export function nmapHandler(deps: SecurityToolDeps): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = nmapInput.parse(call.input);
      const engagement = ctx.engagement;
      const target = input.target;

      // CIDR targets: structural containment BEFORE the pipeline (the
      // per-target engine check covers hosts and the CIDR's base address;
      // a CIDR is authorized only when an authorized CIDR covers it and no
      // exclusion overlaps it).
      const isCidr = target.includes("/");
      if (isCidr && engagement !== null) {
        // A CIDR with host bits set (203.0.113.42/25) is refused outright:
        // the scanned range would depend on the binary's masking semantics
        // (R1-9) — the operator writes the network address or nothing.
        const parsed = parseCidr(target);
        const hostBits =
          parsed === null
            ? 0n
            : parsed.bits & ((1n << BigInt((parsed.family === 4 ? 32 : 128) - parsed.prefix)) - 1n);
        if (hostBits !== 0n) {
          return denied(
            ctx,
            `cidr ${target} has host bits set — write the network address (e.g. ` +
              `${target.split("/")[0]!.replace(/\.[0-9]+$/, ".0")}/${target.split("/")[1]})`,
          );
        }
        const authorized = (engagement.targets.cidrs ?? []).some((a) => cidrCovers(a, target));
        const excluded = (engagement.targets.exclude?.cidrs ?? []).some((e) =>
          cidrOverlap(e, target),
        );
        if (!authorized || excluded) {
          return denied(
            ctx,
            `cidr ${target} is not covered by an authorized cidr (or overlaps an exclusion) ` +
              `of engagement ${engagement.id}`,
          );
        }
      }

      // The engine + egress path check the CIDR's BASE address (an IP
      // literal authorized by the CIDR set); the structural containment
      // check above is what authorizes the whole range.
      const base = isCidr ? target.split("/")[0]! : normalizeHost(target);

      return runSecurityTool({
        tool: "security.nmap",
        binary: "nmap",
        meta: NMAP_META,
        ctx,
        deps,
        targets: [{ host: base }],
        buildArgs: () => {
          // Connect scan (-sT): no raw sockets, works unprivileged inside
          // containers; -Pn skips host discovery pings the network may drop.
          const args = ["-sT", "-Pn", "--open", "-oG", "-"];
          const rate = cooperativeRate(ctx.engagement!, NMAP_META);
          if (rate !== undefined) args.push("--max-rate", String(Math.max(1, rate)));
          if (input.ports !== undefined) args.push("-p", input.ports);
          else args.push("--top-ports", "1000");
          args.push(target);
          return args;
        },
        parse: async (stdout) => {
          // Greppable output (the REAL format): one line per host,
          // "Host: <addr> (<name>)\tPorts: 22/open/tcp//ssh///, ...\tIgnored State: ..."
          // — the Ports field is a TAB-separated field ON the Host line,
          // never a line of its own (R3-5).
          const openPorts: Array<{ host: string; port: number; service: string }> = [];
          for (const line of stdout.split("\n")) {
            if (!line.startsWith("Host:")) continue;
            const fields = line.split("\t");
            const hostMatch = /^Host:\s+(\S+)/.exec(fields[0] ?? "");
            if (hostMatch === null) continue;
            const host = hostMatch[1]!;
            const portsField = fields.find((f) => f.startsWith("Ports:"));
            if (portsField === undefined) continue;
            for (const entry of portsField.slice("Ports:".length).split(",")) {
              // <port>/<state>/<proto>//<service>///
              const parts = entry.trim().split("/");
              const port = Number(parts[0]);
              const state = parts[1];
              const service = parts[3] ?? "";
              if (Number.isInteger(port) && port > 0 && state === "open") {
                openPorts.push({ host, port, service });
              }
            }
          }
          return { kind: "json", json: { target, open_ports: openPorts, count: openPorts.length } };
        },
      });
    },
  };
}
