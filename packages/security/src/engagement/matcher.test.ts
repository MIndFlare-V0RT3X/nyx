// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Engagement } from "@nyx/protocol";
import { checkUrl, parseActionUrl } from "./matcher.js";

const NOW = 1_700_000_000_000;

function engagement(overrides: Partial<Engagement> = {}): Engagement {
  return {
    id: "ENG-2026-042",
    operator_id: "owner",
    authorized_at: NOW - 60_000,
    expires_at: NOW + 3_600_000,
    targets: { cidrs: [], domains: [] },
    ...overrides,
  };
}

describe("parseActionUrl", () => {
  it("extracts host, explicit port, and the normalized URL", () => {
    expect(parseActionUrl("https://app.example.com/portal/login")).toEqual({
      host: "app.example.com",
      url: "https://app.example.com/portal/login",
    });
    expect(parseActionUrl("HTTP://Example.COM:8443/x")).toEqual({
      host: "example.com",
      port: 8443,
      url: "http://example.com:8443/x",
    });
  });

  it("refuses non-http(s), userinfo, and malformed targets", () => {
    expect(parseActionUrl("ftp://example.com/f")).toBeNull();
    expect(parseActionUrl("https://user:pass@example.com/")).toBeNull();
    expect(parseActionUrl("not a url")).toBeNull();
    expect(parseActionUrl("https://")).toBeNull();
  });
});

describe("checkUrl — the security tools' single scope entry point", () => {
  const eng = engagement({
    targets: {
      cidrs: ["203.0.113.0/24"],
      domains: [],
      urls: ["https://app.example.com/portal/*"],
      exclude: { cidrs: ["203.0.113.128/25"] },
    },
  });

  it("allows an in-scope URL and reports the matched entry", () => {
    expect(checkUrl(eng, "https://app.example.com/portal/login", NOW)).toEqual({
      allowed: true,
      reason: "url in engagement scope",
      matched: "https://app.example.com/portal/*",
    });
  });

  it("an IP target goes through the CIDR path — exclusions included", () => {
    expect(checkUrl(eng, "https://203.0.113.42/admin", NOW).allowed).toBe(true);
    expect(checkUrl(eng, "https://203.0.113.128/admin", NOW).allowed).toBe(false);
  });

  it("out-of-scope URLs and malformed targets are denied with a reason", () => {
    const denied = checkUrl(eng, "https://evil.example.com/portal/login", NOW);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("not in engagement scope");
    const malformed = checkUrl(eng, "javascript:alert(1)");
    expect(malformed.allowed).toBe(false);
    expect(malformed.reason).toContain("malformed action url");
  });

  it("the window start denial flows through with the exact token", () => {
    const future = engagement({
      starts_at: NOW + 60_000,
      targets: { cidrs: [], domains: ["example.com"] },
    });
    const r = checkUrl(future, "https://example.com/x", NOW);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("engagement_not_yet_active");
  });
});
