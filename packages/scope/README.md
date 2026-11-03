# @nyx/scope

The engagement scope engine. An `Engagement` (see `@nyx/protocol`) is an
immutable, per-session target set authorized at session creation; every
security-relevant network egress is checked against it. This package is pure
functions only — no I/O, no clock reads except the explicitly injectable
`now`. Deny-first: anything not clearly inside the engagement is denied.

## Public exports

From `src/ip.ts`:

- `parseIPv4(s: string): bigint | null` — strict dotted quad (no shorthand, no
  leading-zero octets).
- `parseIPv6(s: string): bigint | null` — full RFC-4291-style textual parsing:
  `::` compression (once, ≥1 zero group), embedded IPv4 tails
  (`::ffff:192.168.0.1`), 1–4 digit hextets, case-insensitive. Zone IDs are
  rejected.
- `isIPLiteral(host: string): boolean` — bare or fully bracketed IP literal.
- `parseCidr(cidr: string): { family: 4 | 6; bits: bigint; prefix: number } | null`
  — validates the prefix range (0–32 / 0–128).
- `cidrContains(cidr: string, ip: string): boolean` — same family only; an
  IPv4 CIDR never covers an IPv6 literal and vice versa.
- `normalizeHost(host: string): string` — trim, lowercase, unwrap `[...]`
  (dropping any `:port` after the bracket), strip `:port` only when the host
  part has exactly one colon and the suffix is all digits (bare IPv6
  survives), drop one trailing dot.
- `type CidrInfo`

From `src/engine.ts`:

- `validateTargets(targets: ScopeTargets): string[]` — problems list for the
  server to run at session creation (empty = valid).
- `checkTarget(engagement: Engagement, query: ScopeTargetQuery, now?: number): ScopeCheckResult`
- `makeScopeChecker(engagement: Engagement, now?: () => number): ScopeChecker`
- `engagementSummary(engagement: Engagement): string`

## Usage

```ts
import { makeScopeChecker, validateTargets } from "@nyx/scope";

const problems = validateTargets(sessionTargets); // [] at creation time
const check = makeScopeChecker(engagement /*, () => fakeNow for tests */);
const result = check({ host: "app.example.com", port: 443 });
if (!result.allowed) throw new Error(result.reason);
```

## Design notes / invariants

- **Expiry gates everything.** `now >= expires_at` denies before any other
  check, with the expiry instant in the reason.
- **Domains never authorize raw IPs.** An IP literal must be contained by a
  CIDR in `targets.cidrs`; a hostname must suffix-match a domain in
  `targets.domains` on a dot boundary (`example.com` covers
  `app.example.com`, never `evil-example.com` or `xexample.com`).
- **Exclusions override inclusions.** `exclude.cidrs` / `exclude.domains`
  (same family rules) turn an otherwise-allowed target into
  `"target excluded by engagement"`.
- **Ports:** the deny list always wins; when an allow list is present
  (even empty) it restricts. Port rules are only applied when the query
  carries a port.
- **Normalization** (`normalizeHost`) runs before matching, so
  `EXAMPLE.com.`, `example.com:443`, `[2001:db8::5]:443` all resolve to the
  same host.
- **validateTargets** checks CIDR/domain syntax, port sanity (integer
  1–65535, duplicates within each list), and duplicates inside each list.
  Domains must be registrable-style: ≥2 labels, `[a-z0-9-]` labels without
  leading/trailing hyphens (≤63 chars), and an alphabetic TLD (≥2 chars).
  Duplicate detection is case-insensitive for domains, exact for CIDRs.
  Overlap between `targets` and `exclude` is legal (exclusion wins), so it is
  not flagged.
- Parsers are strict on purpose: ambiguous forms (`010.1.1.1`,
  `10.0.0.0/08`, `1:2:::3`) are rejected rather than guessed.

## Intentionally deferred

- No DNS resolution or pinning: scope checks are literal-string based; a
  hostname that resolves to an out-of-scope IP is a transport-layer concern.
- No IP-intelligence feeds, ASNs, or geo rules.
- CIDR lists are re-parsed per check (fine at Phase 0 target-set sizes); a
  pre-parsed cache can be added behind `makeScopeChecker` later without
  changing the contract.
