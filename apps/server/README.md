# @nyx/server

> The NYX app server: REST + SSE + WebSocket surfaces over the single agent
> loop. Local-first, loopback by default, bearer-token auth.

The server is a *surface*, not a second runtime: it constructs the same
`RunContext` every surface constructs and drives the same `AgentLoop`
(`@nyx/agent`). It owns the wiring (stores, policy engine, sandbox provider,
tool runtime, persona cache, model router), the serialized event sink, and the
turn runner — nothing else.

## Public API

The external contract is fixed in `docs/PROTOCOL.md` (route table, SSE
framing, WS frames). Summary:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/sessions` | create (optional engagement scope) |
| GET | `/v1/sessions` | list |
| GET | `/v1/sessions/:id` | meta + projection |
| GET | `/v1/sessions/:id/events?from_seq=` | SSE stream (`Last-Event-ID` resume) |
| POST | `/v1/sessions/:id/turns` | start a turn → `202 {turn_id}` |
| POST | `/v1/sessions/:id/fork` | fork at seq |
| GET | `/v1/approvals?session_id=` | pending approvals |
| POST | `/v1/approvals/:id` | resolve (owner-only for R4) |
| GET | `/v1/models` | registry |
| GET | `/v1/health` | public health probe |
| WS | `/v1/ws?token=` | multiplexed subscriptions |

Exports: `createServer(deps) → NyxServer` (`app`, `start`, `close`, `auth`,
`approvals`), plus the reusable modules (`createEventSink`, `createLogger`,
`resolveAuth`/`authenticate`, `buildProviders`, `injectWebSocketServer`).

## Design notes

- **EventSink (ordering contract).** Every append to the session event log
  from this process — the loop's pump, the approval engine's post-commit
  callbacks — chains through one promise queue, so the global seq order is a
  total order. The loop receives the sink-wrapped store as `ctx.session`.
- **Approval events.** The engine (`@nyx/policy`) has no route to the event
  log (output separation). Its `onCreated`/`onResolved` callbacks append
  `approval.requested`/`approval.resolved` through the sink and fan out to
  WS subscribers.
- **Turn runner.** One turn per session at a time (409 while busy; per-session
  lane queues are Phase 1). `task` in the turn body is accepted but unused —
  Phase 0 routes every turn through the default chain.
- **Mock provider adapter.** A `kind: mock` config entry is wrapped so every
  `complete()` runs a fresh one-turn script — unlimited turns offline. Tests
  inject fully scripted `MockProvider`s through `deps.providers`.
- **Sandbox.** One sandbox per session, provisioned lazily on first turn,
  `network: "none"`, destroyed on server close.
- **Auth.** Bearer tokens: the owner token (R4 resolutions) and named actor
  tokens from `server.auth`; timing-safe comparison. WS auth is `?token=`
  (browsers cannot set WS headers; the default bind is loopback). With no
  config file, `main.ts` boots a mock+local fallback config and prints a
  generated owner token exactly once — never persisted.
- **CORS.** `localhost`/`127.0.0.1` origins only (dev web client).

## Running

```
node apps/server/dist/main.js          # reads NYX_CONFIG_PATH | ./nyx.config.yaml
NYX_DATA_DIR=~/.nyx                    # where nyx.db + policy.db live
```

Tests run through `app.request()` (no port) except the WS round-trip, which
binds an ephemeral port. Provider injection keeps the suite offline.

## Deferred

Per-session lane queues and channel fan-out (Phase 1), task-tagged routing
(loop seam exists), TLS, remote (non-loopback) hardening.
