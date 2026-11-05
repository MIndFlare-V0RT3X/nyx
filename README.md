# NYX

> A local-first, memory-first, security-first personal agent runtime.
> **The harness, not the model.**

NYX turns a stateless LLM into a stateful operator: sessions persist across
restarts as append-only event logs, tools execute inside sandboxes behind a
deny-first policy broker, memory is markdown you can read, and the persona is
a first-class directory of files with an operator contract that binds
evidence and scope discipline — not refusal suppression.

**Status:** v0.7.0 — the first publishable release. Phases 0–7 complete and tested (1299 passing tests + 21 docker-gated bypass proofs; see `docs/ROADMAP.md`).

## Security model

Read this before anything else — it is the honest summary, including where
the guarantees end (`docs/SECURITY-MODEL.md` has the full model).

**The one residual that narrows a guarantee (R1-2):** engagement sandbox
networks are docker `--internal` bridges, which confine FORWARD-path egress
but **not the host INPUT path** — a container can still reach services
listening on the host (including other bridges' gateways). NYX's own egress
listeners are source-subnet-gated; other host services are not NYX's to
firewall. Operators who want them unreachable add one DOCKER-USER rule
(documented in `docs/EGRESS-PROXY.md`): `iptables -I DOCKER-USER -i br-+ !
-d 172.16.0.0/12 -j DROP`.

The structural guarantees:

- **Credentials live in one place.** The kernel process (in split mode:
  the only process that reads credential env vars; everything else gets
  scoped 60-second tokens — `docs/PROCESS-MODEL.md`). Agent code holds no
  long-lived secrets.
- **Deny-first policy.** Every tool call is evaluated before execution:
  `deny > ask > allow`, risk tiers R0–R4; R4 always requires owner
  approval, and config cannot lower the floor on `host.access`,
  `credential.use`, `git.push`, or `deploy`.
- **Engagement scope.** Offensive tooling exists in a session only behind
  an authorized scope file; every network egress is checked against it —
  at the tool layer AND at the kernel-process egress proxy (DNS-pinned,
  rate-limited, audit-logged).
- **Sandboxed execution.** Tools run in sandboxes with no ambient
  authority; path containment, scope, policy, and approval all gate the
  call before anything executes.
- **Hash-chained audit.** Sessions, approvals, and tool events land on a
  tamper-evident chain; the chain is verified at every boot.
- **Known limits, on the record:** host INPUT reachability (above);
  CONNECT's path-blindness for TLS targets (the tool layer enforces paths;
  `docs/EGRESS-PROXY.md`); prompts necessarily reach the configured model
  endpoint. The complete residual ledger — every open residual with its
  owner and target — lives in `docs/SECURITY-MODEL.md` and
  `docs/SECURITY-SUBSYSTEM.md`.

Vulnerability reports: GitHub security advisories, please (`SECURITY.md`).

## Quickstart

```bash
corepack enable            # pnpm 9 via your Node >= 22 install
pnpm install
pnpm build
pnpm test
```

Talk to it — offline, zero config (the mock provider answers; a real
provider is one config file away):

```bash
node apps/cli/dist/main.js run "hello"     # → exit 0, reply on stdout
node apps/cli/dist/main.js doctor          # node/sqlite/docker/config/providers
node apps/cli/dist/main.js chat            # Ink TUI: streaming, tools, approvals
```

Bring your own model (any OpenAI-compatible endpoint — hosted or
self-hosted: llama.cpp, LM Studio, vLLM, Ollama — or Anthropic):

```bash
node apps/cli/dist/main.js init            # writes nyx.config.yaml (mock by default)
$EDITOR nyx.config.yaml                    # point router.default.chain at your provider
export NYX_ZAI_API_KEY=...                 # keys come from env vars named in config, never files
node apps/cli/dist/main.js run "hello"
```

Run the app server + web client:

```bash
node apps/server/dist/main.js              # http://127.0.0.1:8787 (prints an owner token if none configured)
pnpm --filter @nyx/web dev                 # http://localhost:5173 → paste the token
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ KERNEL (trusted)     config · policy engine · approvals · audit   │
│                      credential vault · nyx.db · egress proxy     │
├──────────────────────────────────────────────────────────────────┤
│ AGENT RUNTIME        one loop, DI-only: prompt assembly, model    │
│ (semi-trusted)       calls, tool dispatch — no credentials        │
├──────────────────────────────────────────────────────────────────┤
│ TOOL RUNTIME         validation → path containment → scope →      │
│ (untrusted)          policy → approval → sandboxed execution      │
├──────────────────────────────────────────────────────────────────┤
│ MODEL PROVIDER       any OpenAI-compatible endpoint or Anthropic  │
│ (external)           sees prompts and tool schemas only           │
└──────────────────────────────────────────────────────────────────┘
```

- **Event-sourced sessions.** The append-only log is the only source of
  truth; messages, tool calls, approvals, and usage are projections. Fork
  and replay are free (`POST /v1/sessions/:id/fork`).
- **Deny-first policy.** `deny > ask > allow`, risk tiers R0–R4. R4 always
  requires the owner. Approvals bind to a sha256 digest of the exact
  action, expire in 10 minutes, and are single-use.
- **Engagement scope.** Security-relevant network egress is checked against
  the session's immutable engagement scope (CIDRs + domain suffixes, port
  policy, exclusions, expiry). Out-of-scope targets are **denied, not
  asked**. No engagement declared ⇒ no external egress.
- **One loop, many surfaces.** CLI, server, and any future channel drive
  the same `AgentLoop` through the same `RunContext`. Only rendering
  differs.

Full details: `docs/ARCHITECTURE.md`, `docs/SECURITY-MODEL.md`,
`docs/PROTOCOL.md` (the REST/SSE/WS contract), `docs/PERSONA.md`,
`docs/TASKS.md` (durable tasks + retention), `docs/SKILLS.md` (skills).

## Layout

| Path                 | What                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`  | frozen shared contracts + boundary Zod schemas                                                                                |
| `packages/config`    | config schema/loader, `${VAR}` interpolation, BRAND                                                                           |
| `packages/kernel`    | plugins, priority hook bus, capability enforcement                                                                            |
| `packages/session`   | event log, projections, fork, replay (SQLite)                                                                                 |
| `packages/model`     | providers (OpenAI-compatible / Anthropic / mock), router, redaction                                                           |
| `packages/scope`     | engagement scope engine (CIDR/domain/port matching)                                                                           |
| `packages/policy`    | deny-first rules, immutable invariants, approvals, hash-chained audit                                                         |
| `packages/sandbox`   | local (dev-only) + docker sandbox providers, path containment                                                                 |
| `packages/tools`     | registry/router/runtime + `fs.read/write/list`, `shell.exec`, `web.fetch`                                                     |
| `packages/memory`    | markdown store + SQLite FTS5 index, compaction                                                                                |
| `packages/persona`   | persona loader, deterministic 8-section prompt assembly                                                                       |
| `packages/agent`     | the single DI agent loop                                                                                                      |
| `packages/runtime`   | lane queue (per-session serial turns), cron, heartbeat scheduler                                                              |
| `packages/channels`  | webhook + Telegram ingress, identity/session mapping, `/new` `/fork`                                                          |
| `packages/subagents` | the subagent system: spawn, fork, artifact handoff (`docs/SUBAGENTS.md`)                                                      |
| `packages/tasks`     | durable tasks: SQL leases, state machine, retention (`docs/TASKS.md`, `docs/RETENTION.md`)                                    |
| `packages/skills`    | progressive-disclosure SKILL.md packages (`docs/SKILLS.md`)                                                                   |
| `packages/security`  | engagement scope engine, findings DB + CVSS, reports (`docs/SECURITY-SUBSYSTEM.md`, `docs/ENGAGEMENT.md`, `docs/FINDINGS.md`) |
| `apps/server`        | Hono: REST + SSE + WS, bearer auth, owner-bound R4, channels, heartbeats                                                      |
| `apps/cli`           | the `nyx` binary: run/chat/sessions/approvals/doctor                                                                          |
| `apps/web`           | minimal React client (64 KB gzipped)                                                                                          |
| `personas/default`   | Nyx — honest operator contract, scope discipline                                                                              |
| `personas/security`  | the engagement posture: scope-bound, evidence-first, report-oriented                                                          |
| `skills/security`    | the six security skills (persona-scoped; add `./skills` to `skills.dirs`)                                                     |
| `tests/e2e`          | smoke · approval · scope · replay · compaction · subagents · fan-out                                                          |

## Config reference

`nyx.config.example.yaml` is the complete, commented reference: `server`
(auth), `providers` (mock / openai-compatible / anthropic; local endpoints
are first-class), `router` (fallback chains, task rules, budgets), `policy`
(rules — the invariants cannot be weakened from config), `sandbox` (docker
default; local is dev-only and refuses to run in production), `memory`,
`persona`, `logging` (redaction list), `subagents` (depth, budgets, tool
allowlists — see `docs/SUBAGENTS.md`). Secrets live in env vars named by
`api_key_env` — never in files.

## Persona

A persona is a directory: `persona.yaml` (voice, cognition, contract,
capabilities, memory policy) plus `SOUL.md` (character), `CONTRACT.md` (the
operator binding: evidence, scope discipline, honest boundaries),
`USER.md`, `MEMORY.md`. Assembly order is fixed and golden-tested. See
`docs/PERSONA.md`. The contract refuses out-of-scope work in one line and
gives a real "no" with a reason — it never instructs the model to override
safety behavior.

## Security details

The summary and residual ledger are at the top; this section is the
feature-level detail. Full model: `docs/SECURITY-MODEL.md`.

### Process split (Phase 7.3)

`NYX_PROCESS_MODE=split` boots the trust zones as three OS processes —
nyx-kernel / nyx-agent / nyx-tools — over a token-authenticated JSON-RPC
unix socket. The agent and tool processes hold no credentials (env
scrubbed; scoped 60-second tokens for what they need), never learn the
data dir, and the kernel's IPC token rotates on agent restart
(`docs/PROCESS-MODEL.md`). Single mode stays the default and
byte-identical to Phase 6 until the Phase 8 soak flips it.

### Plugin trust (Phase 7.2)

Third-party plugins pass a three-gate loader before their code is
imported: manifest v2 → index.js sha256 integrity → Ed25519 signature
from the operator's `trusted-keys.json` (empty by default — nothing is
trusted until you say so). The plugin set is host-only mutable; declared
vs exercised capabilities are audited (`nyx plugin audit <dir>`). The
template, keypair generator, and trust model: `templates/plugin/`.

### Behavioral evals (Phase 7.4)

The harness's own integration tests: 12 behavioral evals asserting on the
session event log (not final text), with a recorded baseline that fails CI
on drift. `docs/EVALS.md`.

### Security engagements (Phase 5)

Offensive tooling ships behind the engagement scope engine — an authorized
scope file is the structural precondition for the tools to exist in a
session at all (`docs/SECURITY-SUBSYSTEM.md`):

```
cp engagements/example.yaml engagements/my-engagement.yaml   # edit scope
nyx chat --persona security --engagement engagements/my-engagement.yaml
```

The wrapped tools (subfinder, httpx, nuclei, ffuf, katana, nmap — plus the
Phase 6 exploitation toolkit) fire only for in-scope targets under the
engagement's rate limits, with every allow/deny on the audit chain; nuclei
records findings with hash-verified evidence; the report generator refuses
out-of-scope findings outright. The sandbox image with pinned tool versions:

```
docker build -f Dockerfile.security -t nyx-security:1 .
```

### Egress proxy (Phase 6.1)

Engagement sandboxes run on per-sandbox internal docker bridges whose only
egress is NYX's kernel-process proxy: every outbound connection is
scope-checked, rate-limited, pinned to the validated IP, and audit-logged
(`docs/EGRESS-PROXY.md`). Disabling it is a dev-only double opt-in
(`NYX_ENV=development` + `--allow-direct-egress`) — production refuses the
config outright.

### Exploitation tooling (Phase 6.2)

sqlmap (detection + authorized extraction), Metasploit console access
(search/inspect/run-one-module, R4 per run), Burp integration (the
operator's Burp behind the engagement's egress gate + history capture), and
custom nuclei templates from findings — every exploitation tool structurally
absent unless the engagement declares `exploitation`
(`docs/EXPLOITATION.md`, `engagements/example-exploitation.yaml`).

### CVE mapping + disclosure (Phase 6.3)

correlate-cve (NVD/OSV/GHSA, fixed research hosts) → minimize-poc
(subset-only, never fabricates) → prepare-disclosure (hash-verified package
with a 90-day timeline and email draft) → submit-cve (R4; MITRE form
CONTENT — submission is a human step, by design). `docs/DISCLOSURE.md`.

## Roadmap

| Phase | Scope                                                              |
| ----- | ------------------------------------------------------------------ |
| 0     | foundation (shipped)                                               |
| 1     | channels: webhook + Telegram, lane queues, heartbeat (shipped)     |
| 2     | unified DB, channel approvals, four-tier compaction (shipped)      |
| 3     | subagents: isolated context, summary-only return (shipped)         |
| 4     | durable tasks, retention, sandbox forking, skills (shipped)        |
| 5     | security subsystem: engagements, findings, reports (shipped)       |
| 6     | egress proxy, exploitation tooling, disclosure workflow (shipped)  |
| 7     | release readiness: two-lane CI, plugin trust, process split,       |
|       | behavioral evals, v0.7.0 (shipped)                                 |
| 8+    | split-mode soak (channels/tasks/subagents migrate, default flips), |
|       | DOCKER-USER host hardening, real-model eval baselines, more        |
|       | sandboxes (E2B, Daytona), computer-use                             |

## License

AGPL-3.0-or-later (`LICENSE`; SPDX headers on every source file).
