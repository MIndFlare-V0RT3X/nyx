# Egress Proxy — Design (Phase 6.1)

One page. This closes Phase 5 residuals R1-2 (binaries re-resolve at exec
time) and R1-10 (limiter per-process / per-call granularity).

## Why

The Phase 5 scope engine is enforced at the harness layer: the tool dispatches,
`scope.check()` runs, `checkResolvedTarget()` validates the pinned IP. But the
actual binary (nuclei, ffuf, sqlmap) resolves the hostname **again at exec
time** and reaches whatever DNS returns. A DNS-rebinding adversary defeats the
check-time pin. The fix is structural: at the **container layer**, no packet
leaves except through a proxy that only permits what the scope engine approved,
pinned per connection.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ SANDBOX CONTAINER (docker, --internal bridge, ICC off)   │
│                                                          │
│  nuclei / ffuf / curl ──► HTTP(S)_PROXY=gateway:port ──┐ │
│  raw sockets / nmap ────► no route (packets die)      │ │
└───────────────────────────────────────────────────────┼─┘
                                                        │ (the only reachable
                                                        │  address is the
                                                        ▼  bridge gateway)
┌──────────────────────────────────────────────────────────┐
│ KERNEL PROCESS (trusted) — EgressProxyServer             │
│  one CONNECT listener per (network gateway, rate class)  │
│   1. parse CONNECT host:port (strict; anything else →    │
│      socket destroyed)                                   │
│   2. policy.decide(listener context, {host, port})       │
│      = scope.check + resolved-target check + rate limit  │
│      (in-process — see IPC below)                        │
│   3. allow → resolve, pin the IP, connect, splice        │
│      deny  → destroy (RST) + audit row                   │
│   4. every allow/deny writes one audit-chain row         │
└───────────────────────┬──────────────────────────────────┘
                        │ validated, pinned connections only
                        ▼
                  Actual network
```

- **Network**: `docker network create --internal --opt
  com.docker.network.bridge.enable_icc=false nyx-egress-<id>`. `--internal`
  gives the bridge **no NAT/masquerade**: container-originated packets to any
  external address are dropped by the host. The bridge gateway (a host-side
  interface) stays reachable — that is where the listeners bind. ICC off means
  containers on the network cannot talk to each other, only to the proxy.
- **Trust root — listener binding, not client claims**: each sandbox's network
  has its own gateway IP; the proxy binds that gateway with that session's
  engagement context. A container cannot choose another network's gateway
  (docker bridge isolation) and cannot influence which context its connection
  maps to. The `NYX_SESSION_ID`/`NYX_ENGAGEMENT_ID` env tags baked into the
  container are **observability only** — the proxy never trusts them.
- **Rate-class attribution**: one listener per class on the same gateway.
  Base port = the engagement `default` class; each key of
  `engagement.rate_limits` gets `base+1+i` (sorted). Wrappers that take an
  explicit proxy flag (sqlmap `--proxy`, ffuf `-x`, …) point it at their
  class's port; env-honoring tools use the default port. **Documented bound:**
  a process inside the container can point at a different class's port — the
  *tightest* class is evadable, but every listener still charges the per-host
  `default` aggregate bucket (Phase 5 semantics), so no path exceeds the
  engagement's declared per-host rate.
- **DNS inside the sandbox**: name resolution uses docker's embedded resolver
  (a host-side service), so lookups still work, but the container cannot
  *connect* to what it resolves — no route. Tools honor `HTTP(S)_PROXY` and
  delegate connection to the proxy; raw-socket tools (nmap) simply have no
  route and fail. The proxy itself resolves via the pinned `DnsEgressResolver`
  — the container's DNS answers are never used for the connection.

## IPC protocol

The proxy runs **in the kernel process** — same process as the scope engine,
limiter, and audit chain. "IPC" is therefore a function call: the proxy calls
`policy.decide(context, request)` in-process. The only wire protocol is the
one the containers speak to it, plain HTTP CONNECT (RFC 7231):

```
C→P: CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n
P→C: HTTP/1.1 200 Connection Established\r\n\r\n     (then opaque byte splice)
     — or the connection is destroyed (deny; no response bytes)
```

Non-CONNECT requests, malformed headers, oversized headers (8 KiB cap),
invalid host forms (userinfo, `/`, spaces), and ports outside 1–65535 are
destroyed without a response. There is no unix socket to pass through, no
`docker.sock` ever mounted (asserted by tests on the built arg vectors), and
no TLS interception — the proxy gates destinations only.

## Pin semantics

Per CONNECT: `checkTarget` (window, inclusions, exclusions, port policy) →
resolve → `checkResolvedTarget` (every address must be inside an authorized
CIDR and outside every excluded CIDR; hostname-only engagements load with a
warning per Phase 2.0.4) → connect **by IP** (first pinned address that
accepts), never re-consulting DNS for that connection's lifetime. A hostname
that resolves in-scope on the first CONNECT and out-of-scope on the second is
denied on the second — at the scope layer *and* because the pin is rebuilt
from a fresh resolution every CONNECT. The tool layer keeps its own
`scope.check()` and `checkResolvedTarget()` (belt and braces) — the bypass
tests prove both layers independently.

## Rate limits (R1-10)

Token consumption happens at the **proxy, per CONNECT** — not per tool call.
The buckets are the same GCRA `(engagement, class, host)` / `(engagement,
host)` keys as Phase 5, but the store is the shared `nyx.db` (`rate_buckets`
table), so **every kernel process enforces the same buckets** — two NYX
processes on one DB no longer run N× the declared rate. Blocking, never
dropping (dropping makes fuzzing unreliable). The tool layer keeps its
per-call acquire on the same limiter (defense in depth; the proxy's
per-CONNECT charges dominate pacing).

## Startup and the escape hatch

The kernel starts the proxy (binds listeners lazily per sandbox network). If a
listener fails to bind, the sandbox provision **aborts** — no proxy, no tools.
`spec.network: "allowlist"` without a binder, or a bind failure, is a
`provider_error`, not a silent `--network none`.

`nyx.config.yaml`:

```yaml
sandbox:
  egress_proxy:
    enabled: true   # default; the production posture
    port: 3128      # base port on each network gateway
```

`enabled: false` is rejected at config load unless **both**
`NYX_ENV=development` **and** `--allow-direct-egress` are present — then
sandboxes are `--network none` only and the tool layer's `scope.check()` is
the sole gate (the documented Phase 5 posture, kept only for debugging a
broken proxy). `enabled: false` in production is a hard validation error.
Sessions **without an engagement** always get `network: none` (nothing to
authorize). `network: "open"` remains refused — there is no configuration that
produces an unproxied container with egress.

## Audit rows

One row per CONNECT decision, on the existing hash chain, actor
`system:security`, actions `security.egress.allowed` / `security.egress.denied`:

```json
{ "session_id": "…", "engagement_id": "…", "host": "api.example.com",
  "port": 443, "rate_class": "sqlmap", "decision": "allow",
  "reason": "…", "matched": "cidr:203.0.113.0/24", "pinned_ips": ["203.0.113.7"] }
```

Volume is bounded by the rate limiter itself. Proxy-level connection errors
(pinned address refused, upstream reset) are not scope decisions and emit no
row — the allow row for that CONNECT already exists.

## Bypass coverage (the acceptance suite)

namespace escape (no NAT out of an `--internal` bridge) · fd leak (no host
socket or file descriptor is ever mounted into a container — asserted on the
built arg vectors) · unix socket pass (no unix socket exists; only the
gateway TCP listeners) · DNS-over-HTTPS through the proxy (a CONNECT to a DoH
provider is gated like any other destination; DoH resolution cannot create a
connection) · raw socket injection (garbage/non-CONNECT destroyed; raw packets
have no route) · two-layer proof (an out-of-scope CONNECT with the tool layer
bypassed is still denied by the proxy) · proxy down (provision refused).
