# Protocol

The external protocol of a NYX server: the REST API, the SSE event stream, the
WebSocket multiplexing channel, the session event catalogue, the tool runtime
enforcement pipeline, engagement scope semantics, and the error envelope. The
wire truth for every shape is the Zod schemas in
`packages/protocol/src/schemas.ts`; this document is their companion.

- **Transport:** HTTP (Hono) + WebSocket (`ws`) on one server.
- **Auth:** `Authorization: Bearer <token>` on every route. The owner token and
  named actor tokens come from `server.auth` in `nyx.config.yaml`
  (`owner_token` is env-interpolated; the actor name `owner` is reserved). The
  authenticated actor id is bound to every approval decision.
- **Default bind:** `127.0.0.1:8787` (loopback only). The `server` section is
  optional — a headless CLI/tools setup omits it — but when present,
  `server.auth.owner_token` is required.
- **Owner authority:** only the owner may resolve R4 (owner-level) approvals.

## REST API

| Method | Path                               | Request                                              | Response                                         |
| ------ | ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| POST   | `/v1/sessions`                     | `{persona_id?, title?, engagement?}`                 | `201 SessionMeta`                                |
| GET    | `/v1/sessions?limit=&owner_id=`    | —                                                    | `SessionMeta[]`                                  |
| GET    | `/v1/sessions/:id`                 | —                                                    | `{session: SessionMeta, projection: Projection}` |
| GET    | `/v1/sessions/:id/events?from_seq` | —                                                    | SSE stream (`text/event-stream`)                 |
| POST   | `/v1/sessions/:id/turns`           | `{content: ContentBlock[] \| {text: string}, task?}` | `202 {turn_id, session_id}`                      |
| POST   | `/v1/sessions/:id/fork`            | `{at_seq: number}`                                   | `201 SessionMeta`                                |
| GET    | `/v1/approvals?session_id=`        | —                                                    | `ApprovalRecord[]` (pending)                     |
| POST   | `/v1/approvals/:id`                | `{decision: "allow" \| "deny"}`                      | `ApprovalRecord` (403 for non-owner on R4)       |
| GET    | `/v1/models`                       | —                                                    | `ModelInfo[]`                                    |
| GET    | `/v1/health`                       | —                                                    | `{status, version, sandbox, providers}`          |
| WS     | `/v1/ws`                           | —                                                    | multiplexed subscription channel                 |

Route notes:

- `POST /v1/sessions` — `persona_id` defaults to the configured
  `persona.default_id`; the owner comes from the token. An `engagement`, when
  supplied, is validated with `@nyx/scope` `validateTargets` (invalid CIDRs,
  domains, or ports are a `400` carrying the problems list) and is then
  **immutable for the session's life**. Creation emits `session.created` with
  the engagement embedded.
- `GET /v1/sessions` — ordered by `updated_at` descending; `limit` defaults to
  50; `owner_id` filters.
- `GET /v1/sessions/:id` — the `Projection` is
  `{session_id, last_seq, messages, tool_calls, approvals, usage}`.
- `POST /v1/sessions/:id/turns` — returns `202` immediately; the turn runs
  asynchronously and its events arrive over SSE or the WebSocket. The
  `{text: string}` shorthand wraps into a text `ContentBlock`. `task` is the
  logical route tag (`RouteOptions.task`) that selects a task-specific model
  chain, e.g. `"compaction"`.
- `POST /v1/sessions/:id/fork` — `at_seq` is an integer ≥ 1 and inclusive: the
  child session's event prefix (events with `seq <= at_seq`) is identical to
  the parent's. The parent's log records `session.forked`.
- `GET /v1/approvals` — pending and unexpired records for the session, newest
  first.
- `POST /v1/approvals/:id` — resolves a pending approval; `decided_by` is the
  authenticated actor. Errors are typed: already-resolved or digest-mismatched
  → `approval_denied`; past TTL → `approval_expired`. Non-owner attempts on an
  R4 approval are `403`.
- `GET /v1/models` — the union across registered providers (failing providers
  are skipped).
- `GET /v1/health` — server status, version, sandbox provider health, and
  provider registry state.

## SSE: `GET /v1/sessions/:id/events`

One SSE record per stored event, in `seq` order — the backlog from `from_seq`
(inclusive) first, then the live tail:

```
id: 42
event: nyx
data: {"type":"turn.started","session_id":"s1","turn_id":"t1","ts":1730000000000,"seq":42}

id: 43
event: nyx
data: {"type":"text.delta","session_id":"s1","turn_id":"t1","text":"hello","ts":1730000000001,"seq":43}

```

- `id` is the event's `seq`; `event` is always `nyx`; `data` is the full
  `StoredEvent` JSON (the event payload plus `seq`).
- **Resume:** a reconnecting client sends the `Last-Event-ID` header with the
  last `seq` it saw, or passes `from_seq` as a query parameter. Both are
  inclusive; the stream replays everything after them, then continues live.
- **Heartbeat:** a comment line (`: hb`) is sent every 15 seconds of silence so
  intermediaries do not close the connection.

## WebSocket: `/v1/ws`

A single multiplexed channel; one connection may subscribe to many sessions.
Frames are JSON text messages.

Client → server:

```json
{ "type": "subscribe", "session_id": "s1" }
{ "type": "unsubscribe", "session_id": "s1" }
```

Server → client:

```json
{
  "type": "event",
  "event": { "type": "text.delta", "session_id": "s1", "turn_id": "t1", "text": "hello", "ts": 1730000000001, "seq": 43 }
}
{
  "type": "approvals",
  "records": [
    {
      "id": "a1",
      "session_id": "s1",
      "turn_id": "t1",
      "action_digest": "9f2c…",
      "summary": "\"web.fetch\" on url=\"https://app.example.com/\" [risk R2]",
      "risk": "R2",
      "decision": "pending",
      "decided_by": null,
      "created_at": 1730000000000,
      "expires_at": 1730000600000,
      "used_at": null
    }
  ]
}
{ "type": "error", "message": "unknown session" }
```

`event` frames carry the same `StoredEvent` payloads as SSE. `approvals`
frames push the current pending approvals for subscribed sessions (so a
client can render an approval prompt the moment `approval.requested` lands).

## Session event catalogue

Every event carries `session_id` and `ts` (Unix ms); turn-scoped events also
carry `turn_id`. As stored, every event carries the store-assigned `seq`.
Emitters: **loop** (the agent loop), **runtime** (the tool runtime, inside a
turn), **store** (the session store, outside any turn), **surface** (the
server composing engines — approval events are appended via the approval
engine's post-commit callbacks, because the engine itself has no route to the
event log).

| Event type             | Fields (beyond the common ones)                                              | Emitted when                                                                                | Emitter        |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------- |
| `session.created`      | `owner_id`, `persona_id`, `parent_id`, `engagement`                          | a session is created (fork children carry the parent's id)                                  | store          |
| `turn.started`         | —                                                                            | a turn begins                                                                               | loop           |
| `message.user`         | `content: ContentBlock[]`                                                    | the user message is recorded for the turn                                                   | loop           |
| `message.assistant`    | `content: ContentBlock[]`                                                    | the final assistant message is recorded                                                     | loop           |
| `text.delta`           | `text`                                                                       | a streaming text chunk from the model                                                       | loop           |
| `reasoning.delta`      | `text`                                                                       | a streaming reasoning chunk from the model                                                  | loop           |
| `tool.call`            | `call_id`, `name`, `input`                                                   | the model requests a tool call, before enforcement                                          | loop → runtime |
| `tool.result`          | `call_id`, `output: ToolOutput`                                              | the handler returned                                                                        | runtime        |
| `tool.error`           | `call_id`, `error: SerializedError`                                          | the handler threw or timed out                                                              | runtime        |
| `action.denied`        | `call_id`, `reason: "policy" \| "approval" \| "scope"`, `detail`, `rule_id?` | enforcement refused the call                                                                | runtime        |
| `approval.requested`   | `approval_id`, `action_digest`, `summary`, `risk`                            | a policy verdict returned `ask` and the pending approval row was created                    | surface        |
| `approval.resolved`    | `approval_id`, `decision: "allow" \| "deny"`, `decided_by`                   | an operator resolved the approval, or expiry auto-denied it (`decided_by: "system:expiry"`) | surface        |
| `compaction.started`   | `strategy`                                                                   | context compaction begins (Phase 0: `rule-elision`; the other strategies are seams)         | loop           |
| `compaction.completed` | `strategy`, `freed_tokens`                                                   | compaction finished                                                                         | loop           |
| `turn.completed`       | `usage: Usage`                                                               | the turn ended normally                                                                     | loop           |
| `turn.failed`          | `error: SerializedError`                                                     | the turn ended in error (after one recovery attempt)                                        | loop           |
| `session.forked`       | `new_session_id`, `at_seq`                                                   | the session was forked; recorded on the parent's log                                        | store          |

`ToolOutput` is one of `{kind: "text", text}`, `{kind: "json", json}`,
`{kind: "file", path, bytes, mime}`, or `{kind: "artifact", artifact_id, path,
bytes}`. `SerializedError` is `{name, message, code?, stack?, retryable?}` and
never contains secrets (see `@nyx/model` redaction).

## Tool runtime enforcement pipeline

Every tool call produced by the model passes through the same ordered
pipeline in `@nyx/tools` (Phase 0; the contract is
`packages/protocol/src/tools.ts`). No step may be skipped and no handler runs
before every check has passed:

1. **Route.** `ToolRouter.select(call, available)` resolves the call's name to
   a registered `ToolDefinition`. An unknown name produces a typed error
   (`tool_unknown`), never a crash.
2. **Validate.** The input is validated against the definition's
   `input_schema` (`validation_failed` on mismatch).
3. **Contain.** Every path in the input is resolved against the sandbox
   workdir; anything that lands outside it — `..` chains, absolute paths,
   symlink escapes — is rejected with `path_escape` before any handler runs.
   Providers re-enforce containment on their own file APIs.
4. **Scope.** Calls with the `net.egress` capability are checked against the
   session's engagement through the `ScopeChecker` closure. Out-of-scope →
   `action.denied` with `reason: "scope"` (never an approval prompt).
5. **Policy.** `PolicyEngine.evaluate(ActionRequest)` returns a verdict under
   `deny > ask > allow` with the immutable invariants first (R4 always asks;
   dangerous capabilities always ask).
6. **Approval.** On `ask`, `ApprovalEngine.request` blocks until an operator
   resolves the approval or its 10-minute TTL expires (expiry resolves deny).
   On `allow`, the exact-action digest is consumed exactly once.
7. **Execute.** The handler runs inside the sandbox with a timeout and an
   `AbortSignal`; its only interfaces are the `ToolContext`'s `sandbox`,
   `emit`, and `logger`.
8. **Truncate.** Oversized output is capped (64 KB with head/tail retention
   and artifact spillover) so a chatty tool cannot blow the context.
9. **Emit.** `tool.result` (or `tool.error`) is appended to the session log
   and projected.

## Engagement and scope semantics

An `Engagement` is the authorized target set of a session, declared at
`POST /v1/sessions` and immutable for the session's life:

```json
{
  "id": "ENG-2026-042",
  "title": "Quarterly internal assessment",
  "operator_id": "owner",
  "authorized_at": 1730000000000,
  "expires_at": 1730432000000,
  "targets": {
    "cidrs": ["10.0.0.0/8", "2001:db8::/32"],
    "domains": ["example.com"],
    "ports": { "allow": [443, 8443] },
    "exclude": { "cidrs": ["10.0.0.1/32"] }
  },
  "rules": ["business hours only"]
}
```

`ScopeTargets` semantics (`@nyx/scope`, all checks deny-first):

- **`cidrs`** — IPv4/IPv6 CIDR blocks. An IP-literal host must be contained by
  one of them, **in the same family** (an IPv4 CIDR never covers an IPv6
  literal and vice versa).
- **`domains`** — suffix match on a dot boundary: `example.com` covers
  `app.example.com`, never `evil-example.com` or `xexample.com`. **Domains
  never authorize raw IPs** — an IP literal must come from `cidrs`.
- **`ports`** — the deny list always wins; an allow list, when present (even
  empty), restricts. Port rules apply only when the query carries a port.
- **`exclude`** — explicit carve-outs (`cidrs`, `domains`) that override the
  allow sets: an otherwise-allowed target becomes a deny.
- **Expiry** — `expires_at` (Unix ms) gates everything: at or after it, every
  scope check denies.
- **Evaluation order** — expiry → inclusion → exclusion → port policy → allow.

Two hard rules at the API level:

- **Out-of-scope is a deny, never an ask.** Scope is not negotiable
  mid-session; widening it means a new or amended engagement (a new session).
- **No engagement, no external network egress.** A session created without an
  engagement has no scope, so every `net.egress` action is denied.

Host normalization runs before matching (`EXAMPLE.com.`,
`example.com:443`, `[2001:db8::5]:443` all reduce to a comparable host), and
parsers are strict — ambiguous forms like `010.1.1.1` or `10.0.0.0/08` are
rejected rather than guessed.

## Errors

Every error response uses one envelope:

```json
{ "error": { "code": "scope_denied", "message": "host evil.example.net not in engagement scope" } }
```

`code` is always a `NyxErrorCode` from `@nyx/protocol`:

| Code                  | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `policy_denied`       | a policy rule returned `deny`                                                     |
| `approval_denied`     | an approval was denied, already resolved or consumed, or the digest did not match |
| `approval_expired`    | the approval's 10-minute TTL elapsed                                              |
| `scope_denied`        | the engagement scope refused the target (or no engagement exists for egress)      |
| `path_escape`         | a path resolved outside the sandbox workdir                                       |
| `tool_unknown`        | no tool registered under that name                                                |
| `tool_timeout`        | execution exceeded its deadline                                                   |
| `tool_failed`         | the handler failed                                                                |
| `validation_failed`   | request, input, or config validation failed                                       |
| `capability`          | a plugin exercised a capability it did not declare                                |
| `engagement_required` | the action needs a bound engagement and none exists                               |
| `budget_exceeded`     | a token budget was exceeded                                                       |
| `provider_error`      | a model provider failed (after fallback)                                          |
| `aborted`             | the operation was aborted                                                         |
| `not_implemented`     | an intentional Phase 0 seam (e.g. docker `allowlist`/`open` networking)           |

HTTP status mapping: `400` validation failures, `401` missing/invalid bearer
token, `403` owner-only operations attempted by a non-owner (R4 approval
resolution), `404` unknown session or approval. The envelope's `code` carries
the precise cause in every case.
