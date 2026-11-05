# Channels

External ingress surfaces for NYX: webhook (the universal fallback) and
Telegram (the common personal-agent ingress). Channels are **disabled by
default** — an operator opts in per adapter in `nyx.config.yaml`.

## The one rule

Every channel turn runs through the **same machinery as the HTTP API**: the
session's lane in `@nyx/runtime`'s lane queue, the one agent loop, the deny-first
policy engine, the approval flow, the sandbox. Channels add **no parallel
policy path**. What a channel adds is _ingress_ — a new way for an operator's
message to arrive — never new authority.

## Architecture

```
webhook HTTP POST ─┐
                   ├─> ChannelManager (@nyx/channels)  ──> TurnRunner (server)
telegram long-poll ┘    identity · session mapping          lane queue → agent loop
                        /new · /fork                        policy → approvals → sandbox
                        rejection audit
```

- **Adapters** (`ChannelAdapter`) are transport only: they translate platform
  payloads into `InboundMessage`s and render `OutboundMessage`s.
- **The manager** is the policy point: identity resolution against the
  operator's configured allow lists, conversation → session mapping, and
  command handling. Adapters never talk to the runtime directly.
- **The TurnRunner** (implemented by the server) starts turns that are
  indistinguishable from API turns.

## Identity mapping (the anti-abuse boundary)

Each `channel_user_id` must map to a known owner, configured per channel:

```yaml
channels:
  webhook:
    allowed_owners: ["owner:primary"] # POST bodies must carry one of these
  telegram:
    allowed_user_ids: [123456789] # numeric Telegram user ids
```

- Webhook: the POST body's `channel_user_id` must be in `allowed_owners`; the
  session owner is that value.
- Telegram: the message sender's numeric id must be in `allowed_user_ids`; the
  session owner is `telegram:<id>`.

**Unrecognized users are rejected with an audit row and no reply** — a 403 for
webhook, silence for Telegram. The rejection lands in the policy hash chain
(`action = channel.identity.rejected`), so abuse attempts are provable after
the fact.

## Session mapping

The conversation key is `sha256(channel + ":" + channel_user_id + ":" + thread_id)`
persisted in `data_dir/channels.db`. First message creates a session;
subsequent messages attach. `/new` starts a fresh session; `/fork` forks the
current one at its last event. Both commands are handled by the manager — the
model never sees them as turns.

## Webhook

A loopback-bound HTTP listener (`bind`, `port`, `path` from config):

```
POST /webhook  {"channel_user_id": "owner:primary", "text": "hello"}
→ 200 {"session_id": "…", "turn_id": "…", "reply": "…"}
```

Non-streaming by design: the adapter waits for turn completion (up to
`reply_timeout_ms`, default 60s) and sends the reply **exactly once**, in the
HTTP response. A turn that outlasts the timeout answers `202` with the
session and turn ids — poll the SSE stream or the session endpoint for the
result. Unknown users get `403`.

## Telegram

Long-polling `getUpdates` against the Bot API; the bot token is read from the
environment (`bot_token_env`, default `NYX_TELEGRAM_BOT_TOKEN`) — never from
the config file.

Streaming replies: the adapter sends one message and **edits it as deltas
arrive**, throttled to `edit_interval_ms` (default 1500ms; the floor is 1200ms
out of respect for Telegram's real edit rate), with the final text on turn
completion. Replies longer than 4096 characters are split into multiple
messages. Disallowed senders get no reply at all.

The Bot API client is an interface (`TelegramClient`); the default
implementation talks to `api.telegram.org`, and the test suite runs entirely
against a stub — no network in CI, and the first real network call happens on
the operator's first run.

## Approvals (Phase 2)

An `ask` verdict on a channel turn is **interactive**, not a TTL death: the
approval engine routes `request()` through the presenter registered for the
session (channel TTL: 5 minutes; `channels.<id>.approval_ttl_ms` overrides;
the TTY default stays 10 minutes).

- **Telegram:** the presenter sends the request with an inline keyboard
  `[✅ Allow] [❌ Deny]`. The button press arrives as a `callback_query` and
  routes through the `TelegramApprovalBridge`: the identity gate
  (`allowed_user_ids`) → `engine.resolve()` → `answerCallbackQuery` + a
  keyboard edit recording the decision. **A text message while an approval
  is pending is NOT a decision** — text always queues as a normal turn;
  only the explicit button click resolves (no ambiguous "reply yes"
  binding). On expiry the engine auto-denies and the chat gets
  "⏱ approval expired — action denied".
- **Webhook:** there is no push channel — the pending HTTP request itself
  becomes the presentation: the POST returns
  `{status: "approval_required", approval_id, summary, risk, expires_at,
resolve_url}` and the external client resolves via
  `POST /v1/approvals/<id>/resolve` (bearer auth; same handler and R4
  owner-only gate as the canonical resolve route). Presentations are
  buffered per session, so a fast turn cannot race the response.
- **Abort/close:** `DELETE /v1/sessions/:id/turns` (and session teardown)
  withdraw pending approvals — the presenter is notified, the row resolves
  deny (`system:withdrawn`, audited), and no orphan survives. The aborted
  turn ends `turn.failed` with reason `aborted`.

Decision authority never moves into an adapter: presenters show requests and
relay clicks; the engine and the resolve route decide.

## What channels may never do

- No telemetry: adapters make no outbound calls except the platform the
  operator enabled and the model providers the operator configured.
- No policy weakening: an "ask" verdict on a channel turn waits for approval
  exactly like an API turn — since Phase 2 it presents interactively (see
  "Approvals" above), and un-approved turns time out to deny, never to
  allow.
- No secret material in config: the Telegram token is env-indirect.
- No interpretation of `raw` platform payloads beyond the fields needed to
  build the inbound message; the raw payload is stored for audit only.
