# Security Subsystem (Phase 5)

The security subsystem turns an *authorized engagement* into the structural
precondition for offensive tooling: scope is not advice the model follows —
it is the boundary inside which the tools exist at all.

- **ENGAGEMENT.md** — the engagement file format, matching semantics, and
  the authorization window.
- **FINDINGS.md** — the findings database, CVSS scoring, evidence, and the
  report generator with its out-of-scope gate.
- **SKILLS.md** — the skill system the security skills ride on.

## The three enforcement layers

A security tool call passes three gates before any byte leaves the process:

1. **Structural (registration).** `buildEngagementTooling` wraps the session's
   tool registry in a view that filters every `security.*` tool whose
   technique is not in the session's engagement. An unauthorized tool cannot
   be listed, called, or hallucinated into existence — an attempted call is
   `tool_unknown`. A session with no engagement sees no offensive tools at
   all. Both apps apply the view per turn (`runTurn`) and on the tasks path
   (`taskContextFor`), so subagents inherit it.
2. **Egress path (per call).** Every target is resolved through the pinned
   DNS resolver and validated with `checkResolvedTarget` — the Phase 1
   DNS-rebinding defense. A name that matched at policy time but resolves
   out of scope at connection time never fires. The tool runtime's own
   `net.egress` pre-check (which understands the security tools' input
   shapes) runs before every handler.
3. **Action time (per action, audited).** `createScopeEngine` checks the
   action — technique authorized, window open, every target in scope — and
   writes exactly one audit row per check (`security.scope.allowed` /
   `.denied`) carrying the engagement id and the canonical-JSON action
   digest. The chain is the legal record.

After the gates: the per-host token bucket (below), a charset-guarded argv
composed only from validated input, and the executor.

## Rate limits

Engagement `rate_limits` entries declare `requests_per_second` or
`packets_per_second` (exactly one unit per entry). Buckets are keyed
`(engagement id, rate class, normalized host)`.

- A tool's `rate_class` charges its own bucket; a tool without a matching
  entry charges the shared `default` bucket for that host.
- `rate_limits.default` is ALSO the per-host aggregate ceiling for
  request-rate tools: `ffuf` (20 rps) and `nuclei` (default 10 rps) against
  one host literally share the tighter default bucket — the "same host from
  two tools shares the engagement's tighter rate" rule. A per-tool entry
  looser than `default` is therefore capped by the host aggregate; to give
  a tool headroom, raise `default`.
- Exceeding a limit BLOCKS (the reservation sleeps), never drops — fuzzing
  stays reliable. The bucket starts empty, so the rate is strict: 100
  requests at 20 rps take exactly 5 s.
- Packet-class tools (nmap) count a different unit and charge their own
  class bucket; with no `nmap` entry they derive a conservative ceiling
  from the default request rate.
- The binaries additionally receive their own cooperative rate flag
  (`-rl`, `-rate-limit`, `-rate`, `--max-rate`) derived from the
  engagement.

## Tool wrappers and executors

The six tools (subfinder, httpx, nuclei, ffuf, katana, nmap) funnel through
one pipeline (`packages/security/src/tools/shared.ts`): gates → bucket →
argv → executor → output parser. Only nuclei creates Findings; the others
return structured result data (see each SKILL.md for the preserve-as-
evidence recipe). Executors:

- `security.executor: "sandbox"` (default) — binaries run inside the
  session sandbox via `bash -c`, with every token single-quoted and
  charset-guarded first (`assertSafeTokens`).
- `security.executor: "host"` — binaries run on the host via `spawn`
  without a shell, still charset-guarded. This is the mode for live
  engagements until the container network work lands (below).

**Dockerfile.security** pins every tool (subfinder v2.17.0, httpx v1.12.0,
nuclei v3.11.1, ffuf v2.3.0, katana v1.8.0, nmap 7.93 from Debian) and
fails the build on version mismatch:

```
docker build -f Dockerfile.security -t nyx-security:1 .
```

## Residuals — Phase 5 set CLOSED (Phase 6), Phase 6 set owned

Every Phase 5 residual is closed; the Phase 6 fan-out's residuals carry an
owner and a target phase (a residual without a target phase is a bug, not a
decision):

| Finding | Severity | Reason | Target Phase |
|---|---|---|---|
| ~~Binaries re-resolve at exec time~~ (R1-2) | closed | **Phase 6.1**: the egress proxy — the sandbox's only egress is the kernel-process CONNECT/forward proxy; connections go to the PROXY's validated, pinned IP | — |
| ~~Limiter per process / per tool call~~ (R1-10) | closed | **Phase 6.1**: per-request charging at the proxy with GCRA buckets in nyx.db (BEGIN IMMEDIATE) — every kernel process enforces the same slots | — |
| ~~ffuf wordlist host/sandbox mismatch~~ (R3-12) | closed | **Phase 6.2**: `resolveForExecutor` — the path resolves where the binary reads it; the host executor fails loudly with the turnkey recommendation | — |
| ~~`FindingStore.create()` accepts caller ids~~ (R2-5) | closed | **Phase 6.3**: create() verifies the session row exists and its bound engagement matches the finding's engagement id | — |
| ~~Markdown reports interpolate finding text raw~~ (R2-8) | closed | **Phase 6.3**: every finding-controlled string is HTML-escaped in the Markdown report too (portals render pasted MD as HTML) | — |
| Host INPUT services reachable from engagement bridges (6.4/R1-2) | medium | docker networking reality; the proxy's own listeners are subnet-gated, other host services are not NYX's to firewall — DOCKER-USER operator mitigation documented in EGRESS-PROXY.md | operator / Phase 7 host hardening |
| The docker acceptance suite skips in CI (6.4/R1-6) | medium | CI is hermetic by design; the bypass proofs run where a daemon exists | Phase 7 CI |
| URL-path scoping invisible to CONNECT (6.4/R1-8) | low | CONNECT carries host:port; TLS paths are encrypted — the tool layer enforces paths; plain-HTTP paths ARE enforced via absolute-form forwarding | never (protocol limit) |
| Trusted plugins can re-register submit-cve at R1 (6.4/R3-14) | info | registry is a trusted-plugin surface; the R4 invariant itself is unbypassable | Phase 7 plugin trust |

## The Phase 5 fan-out review

Three parallel reviewers (scope bypass hunt, findings/report integrity,
skill wrapper correctness) produced 38 findings — 11 HIGH, 10 MEDIUM,
17 LOW. Every HIGH and MEDIUM was fixed with a dedicated regression test;
LOWs were fixed where cheap and documented as residuals above. The full
table is in the Phase 5 report; the regression suites live next to the code
they protect (`engine.test.ts`, `rate_limiter.test.ts`, `generator.test.ts`,
`integration.test.ts`, `cvss4.test.ts`).
