# The process model — single and split (Phase 7.3)

NYX runs in two deployment modes. The architecture is identical; the
difference is whether an OS process boundary enforces the trust zones.

```
NYX_PROCESS_MODE=single (default — byte-identical to Phase 6)
┌────────────────────────── one process ──────────────────────────┐
│ kernel zone · agent runtime · tool runtime + sandbox            │
└──────────────────────────────────────────────────────────────────┘

NYX_PROCESS_MODE=split (Phase 7; default in Phase 8 after soak)
┌─ nyx-kernel (trusted) ──────┐   unix socket, token-authenticated
│ config · credential vault   │ ← JSON-RPC v1 (@nyx/ipc)
│ policy engine · approvals   │
│ audit chain · nyx.db        │
│ sessions · tasks · memory   │
└─────────────┬───────────────┘
              │                    ┌─ nyx-tools (untrusted) ───────┐
              │                    │ tool registry + runtime       │
              └────────────────────│ sandbox provider              │
                 kernel socket     │ (tools socket for the agent)  │
                                    └───────────────┬───────────────┘
┌─ nyx-agent (semi-trusted) ──┐                     │ tools socket
│ agent loop · prompts        │─────────────────────┘
│ persona · model router      │
│ remote views (no creds,     │
│ no db handle, no data dir)  │
└─────────────────────────────┘
```

## The boundary

- **nyx-kernel** is the only process that reads credential env vars. The
  vault resolves `api_key_env` names at boot — ONLY the configured provider
  key names; `credential.inject` refuses anything else — and holds them in
  memory. Nothing is ever written to disk (the split e2e asserts ENOENT on
  every plausible credential file path, from inside the tools process).
- **nyx-agent** builds model providers whose API keys arrive via
  `credential.inject` (audited at issue) — the durable env var does not
  exist in the agent process at all (its launcher passes the scrubbed
  environment; `scrubAgentEnv` in `@nyx/split`).
- **nyx-tools** never learns the data dir (`--runtime-dir` only: sockets
  and token files); it holds no credentials and no DB handle, and its
  policy/approval calls are RPCs to the kernel.
- **Per-role authorization (R1-1)**: the socket authenticates possession of
  the token; the ROLE is the authorization unit. The kernel enforces a gate
  map — the tools role gets exactly policy/approvals/session-meta; the
  agent role gets the session/policy/memory surface and credential.inject;
  only kernel-side clients (operators, the e2e drivers, the future channel
  adapters) reach audit.write, approval.resolve, task.*, and
  session.create. `audit.write` actors are STAMPED from the connection
  (`ipc:<role>`), never caller-chosen — a client cannot forge
  `system:security` rows.
- **Untrusted event validation (R1-6)**: the agent validates the tools
  process's event list (type, session, turn, call id) before appending —
  a lying tools process cannot inject approval/message events into the
  session log.
- **Kernel-side engagement (R1-7)**: the tools process resolves the
  session's engagement from the kernel's own session record — the
  request's copy is untrusted input and is ignored for scope decisions.
- **Token rotation**: the kernel rotates the token atomically (temp +
  rename) whenever an authenticated connection closes. A restarting client
  reads the fresh file at its own boot; the pre-rotation token is refused —
  it cannot be replayed.

## Residuals (owned, from the Phase 7.6 fan-out)

| Finding                                                                 | Severity | Reason                                                                                                                                                                                                                                            | Target                                                                                                                                       |
| ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Same-OS-user processes can read each other's files (R1-4, R1-11, R1-13) | medium   | the split confines CODE PATHS, not the OS user: all three processes run as one uid, so a compromised tools process can open nyx.db or the config file directly; `NYX_RUNTIME_DIR` sits inside the data dir                                        | OS-level isolation (separate uids / namespaces) — Phase 8 deployment work; until then the split is a code-path boundary, not a file boundary |
| The scoped token IS the provider key (R1-2)                             | medium   | a usable token for an external API must be that API's key — the scope/TTL envelope (audited issue, configured-name allowlist, 60s semantics) bounds WHO can fetch it and WHAT it names, but the fetched value is the durable secret by definition | never (protocol limit; documented)                                                                                                           |
| Token rotation can be suppressed by a live connection (R1-5)            | low      | a client holding a CURRENT token can keep a connection open to prevent rotation — but holding a connection already implies holding the current token, so this only extends a compromise the attacker already has                                  | per-connection tokens (Phase 8 protocol v2)                                                                                                  |
| The full config file is readable by all three processes (R1-11)         | low      | same-uid (see above); inline `server.auth.owner_token` in nyx.config.yaml would be readable by the tools process — use `NYX_OWNER_TOKEN` env instead                                                                                              | documented operator guidance                                                                                                                 |

## The protocol

Versioned JSON-RPC v1 over NDJSON frames on a unix socket
(`docs` in `packages/ipc/src/protocol.ts`). The handshake is mandatory and
must be the first frame; a wrong token or protocol version destroys the
connection with at most a denial frame. The kernel's request vocabulary is
the brief's narrow set: `session.create/append/read/meta/projection`,
`policy.evaluate`, `approval.request/resolve/pending`,
`credential.inject`, `audit.write`, `memory.write/list/search`,
`task.claim/complete`, `health.ping`. The tools socket carries
`tools.specs/list`, `tool.execute`, `env.probe`.

Tool events (`tool.call`/`tool.result`/`tool.error`/`action.denied`) ride
back to the agent INSIDE the `tool.execute` response, in order; the agent
owns event ordering and appends through the kernel, so the session log and
its in-transaction audit chain are exactly what single mode produces.

## What single mode is

`NYX_PROCESS_MODE` unset or `single`: the apps/server and apps/cli wiring
composes all three zones in one process, exactly as Phase 6 — same tests,
same events, same assertions (hard rule #2). The IPC layer exists and is
fully tested; single mode simply doesn't route through it.

## Phase 7 scope (honest boundaries)

The split exercises the core loop end-to-end: turns, tools, approvals,
memory, audit, credentials, token rotation, crash survival
(`tests/e2e/split-mode.test.ts`, 12 tests, real processes). Still
single-mode surfaces, migrating with the Phase 8 soak:

- channel adapters (webhook/Telegram), heartbeat, the lane queue, and the
  task worker pool (the `task.claim`/`task.complete` RPCs exist; the pool
  that drives them does not run in split yet)
- subagent delegation inside a split agent process
- docker + egress-proxy engagement sandboxes: the tools process runs the
  docker provider WITHOUT the kernel-hosted binder, so engagement
  sandboxes (network `allowlist`) refuse at provision with the standing
  "no proxy, no tools" error — the documented dev posture for split is the
  local sandbox provider
- the security tool wrappers (FindingStore-backed) — they register in the
  single-process surfaces

## Running it

```sh
# Terminal 1 — the kernel (prints its socket + token file)
node apps/split/dist/kernel-main.js --config nyx.config.yaml --data-dir ~/.nyx

# Terminal 2 — the tools process
node apps/split/dist/tools-main.js --config nyx.config.yaml --runtime-dir ~/.nyx/runtime

# Terminal 3 — a one-shot agent turn
node apps/split/dist/agent-main.js --config nyx.config.yaml \
  --runtime-dir ~/.nyx/runtime --message "hello across the boundary"
```

The reference orchestration (scrubbed child envs, boot await, teardown) is
`launchSplitStack` in `@nyx/split` — the same code the e2e suite uses.
