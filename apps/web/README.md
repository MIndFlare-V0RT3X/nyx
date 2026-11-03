# @nyx/web

> Minimal React client for the NYX app server: session list, live session
> view with streaming messages and tool cards, approval panel. Vite + React
> Query; the SSE consumer is hand-rolled because `EventSource` cannot send
> the Bearer header.

## Views

- **SessionList** — table of sessions (title, short id, persona, engagement
  badge, updated) + new-session form with an optional engagement scope
  (id, CIDRs, domains, expiry hours).
- **SessionView** — the projection bootstraps the timeline, then a live SSE
  stream folds events: streaming assistant text, tool-call cards
  (pending/ok/error/denied), denials, approvals, usage footer. Composer
  posts turns; 409/4xx errors render inline.

## Architecture

- `src/api.ts` — typed fetch client for every REST route; error envelopes
  become `ApiError {code, message, status}`.
- `src/sse.ts` — `connectSSE()` (fetch + ReadableStream, Bearer header,
  seq-dedup, 1s/2s/5s reconnect backoff resuming from the last seen seq) and
  the pure `parseSSEChunk()` (WHATWG framing: `\n`, `\r\n`, lone `\r`, multi
  `data:` lines, `:` comments).
- `src/events.ts` — the pure reducer: `stateFromProjection()` seeds the view
  state, `foldEvent()` folds live events, `foldApprovals()` merges REST
  pulls. No React imports — fully unit-tested.
- `src/views/` + `src/components/` — thin rendering over the view state.
- No router, no CSS framework: one `styles.css`, dark terminal-adjacent theme.

## Development

```
pnpm --filter @nyx/web dev     # vite dev server; /v1 proxies to 127.0.0.1:8787
```

Start the app server (`node apps/server/dist/main.js`), paste the owner
token into the auth bar, done. Token and server URL persist in
localStorage; the auth bar's dot shows health.

## Budget

`pnpm --filter @nyx/web build` → ~205 KB JS / **~64 KB gzipped** (budget:
500 KB gzipped).

## Deferred

Routing, the WS channel (SSE covers Phase 0), i18n, virtualized timelines.
