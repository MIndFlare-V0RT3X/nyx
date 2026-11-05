// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Engagement } from "@nyx/protocol";
import { checkTarget, engagementSummary, makeScopeChecker, validateTargets } from "./engine.js";

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

describe("checkTarget — CIDR scope for IP literals", () => {
  const eng = engagement({
    targets: { cidrs: ["10.0.0.0/8", "192.168.1.0/24", "2001:db8::/32"], domains: [] },
  });

  it("allows IPs inside a CIDR and reports the matching CIDR", () => {
    const r = checkTarget(eng, { host: "10.255.0.1", port: 443 }, NOW);
    expect(r).toEqual({ allowed: true, reason: "host in engagement scope", matched: "10.0.0.0/8" });
  });

  it("allows IPv6 inside its CIDR", () => {
    expect(checkTarget(eng, { host: "2001:db8::1" }, NOW)).toEqual({
      allowed: true,
      reason: "host in engagement scope",
      matched: "2001:db8::/32",
    });
  });

  it("denies IPs outside every CIDR", () => {
    expect(checkTarget(eng, { host: "11.0.0.1" }, NOW).allowed).toBe(false);
    expect(checkTarget(eng, { host: "2001:db9::1" }, NOW).allowed).toBe(false);
  });

  it("normalizes host:port and bracketed IPv6 before checking", () => {
    expect(checkTarget(eng, { host: "10.255.0.1:8443", port: 8443 }, NOW).allowed).toBe(true);
    expect(checkTarget(eng, { host: "[2001:db8::5]:443", port: 443 }, NOW).allowed).toBe(true);
  });

  it("never lets domains authorize raw IPs", () => {
    const domainOnly = engagement({
      targets: { cidrs: [], domains: ["10.0.0.1.example.com"] },
    });
    const r = checkTarget(domainOnly, { host: "10.0.0.1" }, NOW);
    // "10.0.0.1.example.com" would suffix-match the hostname form, but a raw
    // IP literal is only ever authorized by a CIDR.
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("cidr");
  });
});

describe("checkTarget — domain suffix matching", () => {
  const eng = engagement({ targets: { cidrs: [], domains: ["example.com"] } });

  it("matches the host itself and any dot-boundary subdomain", () => {
    expect(checkTarget(eng, { host: "example.com" }, NOW)).toEqual({
      allowed: true,
      reason: "host in engagement scope",
      matched: "example.com",
    });
    expect(checkTarget(eng, { host: "app.example.com" }, NOW).allowed).toBe(true);
    expect(checkTarget(eng, { host: "deep.app.example.com" }, NOW).allowed).toBe(true);
    expect(checkTarget(eng, { host: "APP.Example.COM." }, NOW).allowed).toBe(true);
  });

  it("never matches across label boundaries", () => {
    expect(checkTarget(eng, { host: "evil-example.com" }, NOW).allowed).toBe(false);
    expect(checkTarget(eng, { host: "xexample.com" }, NOW).allowed).toBe(false);
    expect(checkTarget(eng, { host: "example.com.tr" }, NOW).allowed).toBe(false);
    expect(checkTarget(eng, { host: "notexample.com" }, NOW).allowed).toBe(false);
  });
});

describe("checkTarget — exclusions override", () => {
  it("excluded domains deny even when a broader target matches", () => {
    const eng = engagement({
      targets: {
        cidrs: [],
        domains: ["example.com"],
        exclude: { domains: ["app.example.com"] },
      },
    });
    expect(checkTarget(eng, { host: "example.com" }, NOW).allowed).toBe(true);
    const r = checkTarget(eng, { host: "app.example.com" }, NOW);
    expect(r).toEqual({ allowed: false, reason: "target excluded by engagement" });
  });

  it("excluded CIDRs deny IPs inside an allowed CIDR", () => {
    const eng = engagement({
      targets: {
        cidrs: ["10.0.0.0/8"],
        domains: [],
        exclude: { cidrs: ["10.10.0.0/16"] },
      },
    });
    expect(checkTarget(eng, { host: "10.9.0.1" }, NOW).allowed).toBe(true);
    expect(checkTarget(eng, { host: "10.10.1.2" }, NOW)).toEqual({
      allowed: false,
      reason: "target excluded by engagement",
    });
  });

  it("excluded domains do not affect raw IPs and vice versa", () => {
    const eng = engagement({
      targets: {
        cidrs: ["10.0.0.0/8"],
        domains: ["example.com"],
        exclude: { domains: ["example.com"] },
      },
    });
    expect(checkTarget(eng, { host: "10.0.0.1" }, NOW).allowed).toBe(true);
  });
});

describe("checkTarget — port policy", () => {
  it("deny list always overrides the allow list", () => {
    const eng = engagement({
      targets: { cidrs: [], domains: ["example.com"], ports: { allow: [443, 8443], deny: [8443] } },
    });
    expect(checkTarget(eng, { host: "example.com", port: 443 }, NOW).allowed).toBe(true);
    expect(checkTarget(eng, { host: "example.com", port: 8443 }, NOW).allowed).toBe(false);
    expect(checkTarget(eng, { host: "example.com", port: 8080 }, NOW).allowed).toBe(false);
  });

  it("a set allow list restricts everything else", () => {
    const eng = engagement({
      targets: { cidrs: [], domains: ["example.com"], ports: { allow: [443] } },
    });
    expect(checkTarget(eng, { host: "example.com", port: 443 }, NOW).allowed).toBe(true);
    expect(checkTarget(eng, { host: "example.com", port: 80 }, NOW).allowed).toBe(false);
  });

  it("a deny list without an allow list leaves other ports open", () => {
    const eng = engagement({
      targets: { cidrs: [], domains: ["example.com"], ports: { deny: [23] } },
    });
    expect(checkTarget(eng, { host: "example.com", port: 23 }, NOW).allowed).toBe(false);
    expect(checkTarget(eng, { host: "example.com", port: 443 }, NOW).allowed).toBe(true);
  });

  it("no port policy means no port restriction (and port-less queries skip the check)", () => {
    const eng = engagement({ targets: { cidrs: [], domains: ["example.com"] } });
    expect(checkTarget(eng, { host: "example.com", port: 6667 }, NOW).allowed).toBe(true);
    expect(checkTarget(eng, { host: "example.com" }, NOW).allowed).toBe(true);
  });
});

describe("checkTarget — expiry", () => {
  const eng = engagement({ targets: { cidrs: ["10.0.0.0/8"], domains: [] } });

  it("denies everything once now >= expires_at", () => {
    const iso = new Date(eng.expires_at).toISOString();
    for (const host of ["10.0.0.1", "example.com", "2001:db8::1"]) {
      const r = checkTarget(eng, { host }, eng.expires_at);
      expect(r).toEqual({ allowed: false, reason: `engagement expired at ${iso}` });
    }
    expect(checkTarget(eng, { host: "10.0.0.1" }, eng.expires_at - 1).allowed).toBe(true);
  });

  it("makeScopeChecker denies everything after expiry with an injected clock", () => {
    const checker = makeScopeChecker(eng, () => eng.expires_at + 1);
    expect(checker({ host: "10.0.0.1" }).allowed).toBe(false);
    expect(checker({ host: "10.0.0.1" }).reason).toBe(
      `engagement expired at ${new Date(eng.expires_at).toISOString()}`,
    );
  });
});

describe("makeScopeChecker", () => {
  it("closes over the engagement and uses Date.now by default", () => {
    // Far-future expiry so the real wall clock (the default `now`) is in scope.
    const eng = engagement({
      expires_at: Date.now() + 3_600_000,
      targets: { cidrs: [], domains: ["example.com"] },
    });
    const checker = makeScopeChecker(eng);
    expect(checker({ host: "app.example.com", port: 443 })).toEqual({
      allowed: true,
      reason: "host in engagement scope",
      matched: "example.com",
    });
    expect(checker({ host: "elsewhere.org", port: 443 }).allowed).toBe(false);
  });
});

describe("engagementSummary", () => {
  it("is one line with id, expiry ISO, cidrs, and domains", () => {
    const eng = engagement({
      title: "Acme lab",
      targets: { cidrs: ["10.0.0.0/8"], domains: ["example.com", "api.example.com"] },
    });
    const summary = engagementSummary(eng);
    expect(summary).toContain("ENG-2026-042");
    expect(summary).toContain(new Date(eng.expires_at).toISOString());
    expect(summary).toContain("10.0.0.0/8");
    expect(summary).toContain("example.com");
    expect(summary).toContain("api.example.com");
    expect(summary).not.toContain("\n");
  });
});

describe("validateTargets", () => {
  it("accepts a clean target set", () => {
    expect(
      validateTargets({
        cidrs: ["10.0.0.0/8", "2001:db8::/32"],
        domains: ["example.com", "app.example.com"],
        ports: { allow: [443], deny: [23] },
        exclude: { cidrs: ["10.10.0.0/16"], domains: ["internal.example.com"] },
      }),
    ).toEqual([]);
  });

  it("rejects bad CIDR syntax and out-of-range prefixes", () => {
    const problems = validateTargets({
      cidrs: ["10.0.0.0/8", "banana", "10.0.0.0/33", "2001:db8::/129"],
      domains: [],
    });
    expect(problems).toContain('invalid CIDR: "banana"');
    expect(problems).toContain('invalid CIDR: "10.0.0.0/33"');
    expect(problems).toContain('invalid CIDR: "2001:db8::/129"');
    expect(problems).toHaveLength(3);
  });

  it("rejects non-registrable domain syntax", () => {
    const problems = validateTargets({
      cidrs: [],
      domains: [
        "example.com",
        "localhost",
        "-bad.com",
        "a..b",
        "example.com.",
        "exa mple.com",
        "x",
      ],
    });
    expect(problems).toContain('invalid domain: "localhost"');
    expect(problems).toContain('invalid domain: "-bad.com"');
    expect(problems).toContain('invalid domain: "a..b"');
    expect(problems).toContain('invalid domain: "example.com."');
    expect(problems).toContain('invalid domain: "exa mple.com"');
    expect(problems).toContain('invalid domain: "x"');
    expect(problems).toHaveLength(6);
  });

  it("flags duplicate entries (domains case-insensitively)", () => {
    const problems = validateTargets({
      cidrs: ["10.0.0.0/8", "10.0.0.0/8"],
      domains: ["example.com", "EXAMPLE.com"],
    });
    expect(problems).toContain('duplicate CIDR: "10.0.0.0/8"');
    expect(problems).toContain('duplicate domain: "EXAMPLE.com"');
  });

  it("validates exclude lists independently", () => {
    const problems = validateTargets({
      cidrs: [],
      domains: ["example.com"],
      exclude: { cidrs: ["nope"], domains: ["ok.example.com", "ok.example.com", "bad"] },
    });
    expect(problems).toContain('invalid CIDR in exclude: "nope"');
    expect(problems).toContain('duplicate excluded domain: "ok.example.com"');
    expect(problems).toContain('invalid domain in exclude: "bad"');
  });

  it("validates ports", () => {
    const problems = validateTargets({
      cidrs: [],
      domains: [],
      ports: { allow: [443, 443, 70000, 0], deny: [-1, 2.5] },
    });
    expect(problems).toContain("duplicate port in allow list: 443");
    expect(problems).toContain("invalid port in allow list: 70000");
    expect(problems).toContain("invalid port in allow list: 0");
    expect(problems).toContain("invalid port in deny list: -1");
    expect(problems).toContain("invalid port in deny list: 2.5");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 §1.4 / §1.7 — matching semantics: window start, wildcards, URL
// targets, and the acceptance fixtures from the Phase 5 brief.
// ─────────────────────────────────────────────────────────────────────────────

describe("checkTarget — engagement window start (Phase 5 §1.7)", () => {
  const eng = engagement({
    starts_at: NOW + 60_000,
    expires_at: NOW + 3_600_000,
    targets: { cidrs: [], domains: ["example.com"] },
  });

  it("denies an action one second before the window opens, with the exact reason token", () => {
    const r = checkTarget(eng, { host: "example.com" }, eng.starts_at! - 1_000);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("engagement_not_yet_active");
    expect(r.reason).toContain(new Date(eng.starts_at!).toISOString());
  });

  it("allows at the boundary (now >= starts_at) — the window is inclusive", () => {
    expect(checkTarget(eng, { host: "example.com" }, eng.starts_at!).allowed).toBe(true);
  });

  it("an engagement without starts_at behaves exactly as before", () => {
    const noStart = engagement({ targets: { cidrs: [], domains: ["example.com"] } });
    expect(checkTarget(noStart, { host: "example.com" }, NOW - 10_000_000).allowed).toBe(true);
  });
});

describe("checkTarget — wildcard domain targets (Phase 5 §1.4)", () => {
  const eng = engagement({
    targets: { cidrs: [], domains: ["*.example.com"] },
  });

  it("matches strict subdomains only — never the apex", () => {
    expect(checkTarget(eng, { host: "api.example.com" }, NOW)).toEqual({
      allowed: true,
      reason: "host in engagement scope",
      matched: "*.example.com",
    });
    expect(checkTarget(eng, { host: "deep.api.example.com" }, NOW).allowed).toBe(true);
    expect(checkTarget(eng, { host: "example.com" }, NOW).allowed).toBe(false);
  });

  it("never matches across label boundaries", () => {
    expect(checkTarget(eng, { host: "notexample.com" }, NOW).allowed).toBe(false);
    expect(checkTarget(eng, { host: "evil.example.com.malicious.net" }, NOW).allowed).toBe(false);
  });

  it("wildcard exclusions carve out strict subdomains and leave the apex alone", () => {
    const eng2 = engagement({
      targets: {
        cidrs: [],
        domains: ["example.com"],
        exclude: { domains: ["*.internal.example.com"] },
      },
    });
    expect(checkTarget(eng2, { host: "internal.example.com" }, NOW).allowed).toBe(true);
    expect(checkTarget(eng2, { host: "a.internal.example.com" }, NOW)).toEqual({
      allowed: false,
      reason: "target excluded by engagement",
    });
  });
});

describe("checkTarget — URL targets (Phase 5 §1.4)", () => {
  const eng = engagement({
    targets: {
      cidrs: [],
      domains: [],
      urls: ["https://app.example.com/portal/*"],
    },
  });

  it("prefix-then-pattern: matches the subtree on segment boundaries", () => {
    expect(
      checkTarget(
        eng,
        { host: "app.example.com", url: "https://app.example.com/portal/login" },
        NOW,
      ),
    ).toEqual({
      allowed: true,
      reason: "url in engagement scope",
      matched: "https://app.example.com/portal/*",
    });
    expect(
      checkTarget(eng, { host: "app.example.com", url: "https://app.example.com/portal" }, NOW)
        .allowed,
    ).toBe(true);
    expect(
      checkTarget(eng, { host: "app.example.com", url: "https://app.example.com/portal/a/b" }, NOW)
        .allowed,
    ).toBe(true);
  });

  it("never matches a sibling path or a boundary-straddling one", () => {
    expect(
      checkTarget(eng, { host: "app.example.com", url: "https://app.example.com/admin/login" }, NOW)
        .allowed,
    ).toBe(false);
    expect(
      checkTarget(eng, { host: "app.example.com", url: "https://app.example.com/portalfoo" }, NOW)
        .allowed,
    ).toBe(false);
  });

  it("scheme and host are matched structurally — no full-string regex", () => {
    expect(
      checkTarget(eng, { host: "app.example.com", url: "http://app.example.com/portal/login" }, NOW)
        .allowed,
    ).toBe(false);
    expect(
      checkTarget(
        eng,
        { host: "app.example.com.evil.net", url: "https://app.example.com.evil.net/portal/login" },
        NOW,
      ).allowed,
    ).toBe(false);
    expect(
      checkTarget(
        eng,
        { host: "evilapp.example.com", url: "https://evilapp.example.com/portal/login" },
        NOW,
      ).allowed,
    ).toBe(false);
  });

  it("URL entries never authorize a bare host query", () => {
    const r = checkTarget(eng, { host: "app.example.com" }, NOW);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("not in engagement scope");
  });

  it("a domain hit still authorizes a URL query (host-level authorization)", () => {
    const eng2 = engagement({
      targets: { cidrs: [], domains: ["example.com"], urls: ["https://app.example.com/portal/*"] },
    });
    expect(
      checkTarget(eng2, { host: "api.example.com", url: "https://api.example.com/anything" }, NOW)
        .allowed,
    ).toBe(true);
  });

  it("exclusions override URL targets via the host", () => {
    const eng2 = engagement({
      targets: {
        cidrs: [],
        domains: [],
        urls: ["https://app.example.com/portal/*"],
        exclude: { domains: ["app.example.com"] },
      },
    });
    expect(
      checkTarget(
        eng2,
        { host: "app.example.com", url: "https://app.example.com/portal/login" },
        NOW,
      ),
    ).toEqual({ allowed: false, reason: "target excluded by engagement" });
  });

  it("the URL's port participates in port policy", () => {
    const eng2 = engagement({
      targets: {
        cidrs: [],
        domains: [],
        urls: ["https://app.example.com/portal/*"],
        ports: { allow: [443] },
      },
    });
    expect(
      checkTarget(
        eng2,
        { host: "app.example.com", url: "https://app.example.com:8443/portal/login" },
        NOW,
      ).allowed,
    ).toBe(false);
    expect(
      checkTarget(
        eng2,
        { host: "app.example.com", url: "https://app.example.com/portal/login" },
        NOW,
      ).allowed,
    ).toBe(true);
  });
});

describe("checkTarget — the Phase 5 §1.7 CIDR acceptance fixture", () => {
  const eng = engagement({
    targets: {
      cidrs: ["203.0.113.0/24", "198.51.100.10/32"],
      domains: [],
      exclude: { cidrs: ["203.0.113.128/25"] },
    },
  });

  it("203.0.113.0/24 matches 203.0.113.42", () => {
    expect(checkTarget(eng, { host: "203.0.113.42" }, NOW).allowed).toBe(true);
  });

  it("the excluded half of the range is denied even inside the authorized CIDR", () => {
    expect(checkTarget(eng, { host: "203.0.113.128" }, NOW)).toEqual({
      allowed: false,
      reason: "target excluded by engagement",
    });
    expect(checkTarget(eng, { host: "203.0.113.200" }, NOW).allowed).toBe(false);
    expect(checkTarget(eng, { host: "203.0.113.127" }, NOW).allowed).toBe(true);
  });

  it("a /32 authorizes exactly one address", () => {
    expect(checkTarget(eng, { host: "198.51.100.10" }, NOW).allowed).toBe(true);
    expect(checkTarget(eng, { host: "198.51.100.11" }, NOW).allowed).toBe(false);
  });
});

describe("validateTargets — wildcards and URLs (Phase 5)", () => {
  it("accepts wildcard domains in targets and exclusions", () => {
    expect(
      validateTargets({
        cidrs: [],
        domains: ["*.example.com"],
        exclude: { domains: ["*.internal.example.com"] },
      }),
    ).toEqual([]);
  });

  it("rejects malformed wildcards", () => {
    const problems = validateTargets({
      cidrs: [],
      domains: ["**.example.com", "*example.com", "*.bad..domain", "*."],
    });
    expect(problems).toContain('invalid domain: "**.example.com"');
    expect(problems).toContain('invalid domain: "*example.com"');
    expect(problems).toContain('invalid domain: "*.bad..domain"');
    expect(problems).toContain('invalid domain: "*."');
    expect(problems).toHaveLength(4);
  });

  it("accepts valid URL targets and rejects malformed ones", () => {
    const problems = validateTargets({
      cidrs: [],
      domains: [],
      urls: [
        "https://app.example.com/portal/*",
        "http://example.com",
        "ftp://example.com/file",
        "https://user:pass@example.com/",
        "https://example.com/?q=1",
        "https://example.com/#frag",
        "not a url",
        "https://",
      ],
    });
    expect(problems).toContain('invalid url target: "ftp://example.com/file"');
    expect(problems).toContain('invalid url target: "https://user:pass@example.com/"');
    expect(problems).toContain('invalid url target: "https://example.com/?q=1"');
    expect(problems).toContain('invalid url target: "https://example.com/#frag"');
    expect(problems).toContain('invalid url target: "not a url"');
    expect(problems).toContain('invalid url target: "https://"');
    expect(problems).toHaveLength(6);
  });

  it("flags duplicate URL targets", () => {
    const problems = validateTargets({
      cidrs: [],
      domains: [],
      urls: ["https://app.example.com/portal/*", "https://app.example.com/portal/*"],
    });
    expect(problems).toContain('duplicate url target: "https://app.example.com/portal/*"');
  });
});
