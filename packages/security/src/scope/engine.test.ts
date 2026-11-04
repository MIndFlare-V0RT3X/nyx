// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, describe, expect, it } from "vitest";
import type { Engagement } from "@nyx/protocol";
import { createScopeEngine } from "./engine.js";
import { registerSecurityToolMeta, clearSecurityToolMeta } from "./tool_filter.js";
import type { EngagementAuditSink } from "../engagement/loader.js";

const NOW = 1_700_000_000_000;

registerSecurityToolMeta("security.probe-web", {
  technique: "web_enumeration",
  rate_class: "httpx",
  unit: "requests",
});
registerSecurityToolMeta("security.probe-ports", {
  technique: "port_scanning",
  rate_class: "nmap",
  unit: "packets",
});
afterAll(() => clearSecurityToolMeta());

function engagement(overrides: Partial<Engagement> = {}): Engagement {
  return {
    id: "ENG-2026-042",
    operator_id: "owner",
    authorized_at: NOW - 60_000,
    expires_at: NOW + 3_600_000,
    targets: { cidrs: ["203.0.113.0/24"], domains: ["example.com"] },
    techniques: ["web_enumeration"],
    ...overrides,
  };
}

interface AuditRow {
  actor: string;
  action: string;
  payload: {
    engagement_id: string | null;
    action_digest: string;
    tool: string;
    reason: string;
    matched?: string;
    [key: string]: unknown;
  };
}

function sink(): { rows: AuditRow[]; audit: EngagementAuditSink } {
  const rows: AuditRow[] = [];
  return { rows, audit: (r) => rows.push(r as AuditRow) };
}

describe("createScopeEngine — the action-time check (§1.3 layer 3)", () => {
  it("no engagement → deny, and the audit row records it", () => {
    const { rows, audit } = sink();
    const engine = createScopeEngine(null, { now: () => NOW, audit });
    const out = engine.check({ tool: "security.probe-web", targets: [{ host: "example.com" }] });
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("no engagement");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("security.scope.denied");
    expect(rows[0]!.payload.engagement_id).toBeNull();
    expect(rows[0]!.payload.action_digest).toBe(out.action_digest);
  });

  it("a technique the engagement does not authorize → deny", () => {
    const { rows, audit } = sink();
    const engine = createScopeEngine(engagement(), { now: () => NOW, audit });
    const out = engine.check({ tool: "security.probe-ports", targets: [{ host: "203.0.113.42" }] });
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain('technique "port_scanning"');
    expect(out.reason).toContain("not authorized");
    expect(rows[0]!.action).toBe("security.scope.denied");
    expect(rows[0]!.payload.engagement_id).toBe("ENG-2026-042");
  });

  it("an out-of-scope target → deny with the matcher's reason", () => {
    const { rows, audit } = sink();
    const engine = createScopeEngine(engagement(), { now: () => NOW, audit });
    const out = engine.check({ tool: "security.probe-web", targets: [{ host: "evil.example.net" }] });
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("not in engagement scope");
    expect(rows[0]!.action).toBe("security.scope.denied");
  });

  it("one out-of-scope target among several denies the whole action", () => {
    const engine = createScopeEngine(engagement(), { now: () => NOW });
    const out = engine.check({
      tool: "security.probe-web",
      targets: [{ host: "example.com" }, { host: "203.0.113.42" }, { host: "10.9.9.9" }],
    });
    expect(out.decision).toBe("deny");
  });

  it("an in-scope action → allow, matched entry, and an allowed audit row", () => {
    const { rows, audit } = sink();
    const engine = createScopeEngine(engagement(), { now: () => NOW, audit });
    const out = engine.check({
      tool: "security.probe-web",
      targets: [{ host: "example.com", port: 443 }, { host: "203.0.113.42" }],
    });
    expect(out.decision).toBe("allow");
    expect(out.matched).toBe("example.com");
    expect(out.action_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("security.scope.allowed");
    expect(rows[0]!.payload.engagement_id).toBe("ENG-2026-042");
    expect(rows[0]!.payload.action_digest).toBe(out.action_digest);
    expect(rows[0]!.payload.tool).toBe("security.probe-web");
    expect(rows[0]!.payload.matched).toBe("example.com");
  });

  it("a not-yet-active engagement denies with engagement_not_yet_active", () => {
    const engine = createScopeEngine(
      engagement({ starts_at: NOW + 60_000 }),
      { now: () => NOW },
    );
    const out = engine.check({ tool: "security.probe-web", targets: [{ host: "example.com" }] });
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("engagement_not_yet_active");
  });

  it("an action with no targets is denied fail-closed", () => {
    const engine = createScopeEngine(engagement(), { now: () => NOW });
    const out = engine.check({ tool: "security.probe-web", targets: [] });
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("no targets");
  });

  it("exactly one audit row per check — allow or deny, never both, never none", () => {
    const { rows, audit } = sink();
    const engine = createScopeEngine(engagement(), { now: () => NOW, audit });
    engine.check({ tool: "security.probe-web", targets: [{ host: "example.com" }] });
    engine.check({ tool: "security.probe-web", targets: [{ host: "bad.example.net" }] });
    engine.check({ tool: "security.probe-ports", targets: [{ host: "203.0.113.42" }] });
    expect(rows.map((r) => r.action)).toEqual([
      "security.scope.allowed",
      "security.scope.denied",
      "security.scope.denied",
    ]);
    expect(rows.every((r) => r.actor === "system:security")).toBe(true);
    expect(rows.every((r) => r.payload.engagement_id === "ENG-2026-042")).toBe(true);
  });
});
