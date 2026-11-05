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
- **Trust root — listener binding + source subnet, not client claims**: each
  sandbox's network has its own gateway IP; the proxy binds that gateway with
  that session's engagement context and accepts connections ONLY from that
  network's subnet (Phase 6.4, R1-1 — `--internal` confines the FORWARD path
  but not the host INPUT path; the subnet check is what makes another
  sandbox's gateway unreachable). The `NYX_SESSION_ID`/`NYX_ENGAGEMENT_ID`
  env tags baked into the container are **observability only** — the proxy
  never trusts them.
- **The host INPUT path (documented residual, R1-2)**: on a stock docker host
  a container on an `--internal` bridge can also reach host services bound on
  non-loopback addresses (published container ports, sshd, anything on the
  LAN IP) — docker networking reality, not a proxy defect; internet-bound
  FORWARD egress remains confined. Operators who need that closed too can
  add a DOCKER-USER rule (see §Residuals below).
- **Rate-class attribution**: one listener per class on the same gateway.
  Base port = the engagement `default` class; each key of
  `engagement.rate_limits` gets `base+1+i` (sorted). Wrappers that take an
  explicit proxy flag (sqlmap `--proxy`, ffuf `-x`, …) point it at their
  class's port; env-honoring tools use the default port. **Documented bound:**
  a process inside the container can point at a different class's port — the
  _tightest_ class is evadable, but every listener still charges the per-host
  `default` aggregate bucket (Phase 5 semantics), so no path exceeds the
  engagement's declared per-host rate.
- **DNS inside the sandbox (dead by design, Phase 6.4 / R1-5)**: the
  container's resolver points at `127.0.0.255` (loopback, no listener —
  instant refusal). Docker's embedded resolver would otherwise forward
  arbitrary names out of the HOST — an ungated exfil channel. Nothing
  breaks: proxied clients send hostnames in CONNECT/absolute-form requests
  and never resolve locally; raw-socket tools (nmap) have no route either
  way. The proxy itself resolves via the pinned `DnsEgressResolver` — the
  container's (nonexistent) DNS answers are never used for the connection.

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

**Plain HTTP (absolute form, Phase 6.4 / R1-4):** every standard client
reaches `http://` targets through a proxy with `GET http://host/path
HTTP/1.1`, not CONNECT. The proxy forwards exactly this form: the request's
authority goes through the SAME decision as a CONNECT, the request line is
rewritten to origin-form, hop-by-hop `Connection` headers are dropped and
`Connection: close` is set (one decision per connection — a pipelined second
request can never ride an unchecked decision), and the response is relayed
verbatim.

Non-CONNECT non-absolute requests, malformed headers, headless streams past
the 8 KiB head cap, invalid host forms (userinfo, `/`, spaces, bracketed
non-literals), and ports outside 1–65535 are destroyed without a response.
There is no unix socket to pass through, no `docker.sock` ever mounted
(asserted by tests on the built arg vectors), and no TLS interception — the
proxy gates destinations only.

## Pin semantics

Per CONNECT: `checkTarget` (window, inclusions, exclusions, port policy) →
resolve → `checkResolvedTarget` (every address must be inside an authorized
CIDR and outside every excluded CIDR; hostname-only engagements load with a
warning per Phase 2.0.4) → connect **by IP** (first pinned address that
accepts), never re-consulting DNS for that connection's lifetime. A hostname
that resolves in-scope on the first CONNECT and out-of-scope on the second is
denied on the second — at the scope layer _and_ because the pin is rebuilt
from a fresh resolution every CONNECT. The tool layer keeps its own
`scope.check()` and `checkResolvedTarget()` (belt and braces) — the bypass
tests prove both layers independently.

## Rate limits (R1-10)

Token consumption happens at the **proxy, per request** (CONNECT or forwarded
absolute-form) — not per tool call. The buckets are the same GCRA
`(engagement, class, host)` / `(engagement, host)` keys as Phase 5, but the
store is the shared `nyx.db` (`rate_buckets` table, BEGIN IMMEDIATE
transactions), so **every kernel process enforces the same buckets** — two
NYX processes on one DB no longer run N× the declared rate. Blocking, never
dropping (dropping makes fuzzing unreliable). The tool layer keeps its
per-call acquire on the same limiter (defense in depth; the proxy's
per-request charges dominate pacing). **Declaring any rate limit requires
`default`** (the per-host aggregate every listener charges) — an engagement
that declares tool classes without it is refused at load (Phase 6.4 / R1-3);
declaring no limits at all remains the operator's explicit choice.

## Startup and the escape hatch

The kernel starts the proxy (binds listeners lazily per sandbox network). If a
listener fails to bind, the sandbox provision **aborts** — no proxy, no tools.
`spec.network: "allowlist"` without a binder, or a bind failure, is a
`provider_error`, not a silent `--network none`.

`nyx.config.yaml`:

```yaml
sandbox:
  egress_proxy:
    enabled: true # default; the production posture
    port: 3128 # base port on each network gateway
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
{
  "session_id": "…",
  "engagement_id": "…",
  "host": "api.example.com",
  "port": 443,
  "rate_class": "sqlmap",
  "decision": "allow",
  "reason": "…",
  "matched": "cidr:203.0.113.0/24",
  "pinned_ips": ["203.0.113.7"]
}
```

Volume is bounded by the rate limiter itself. Proxy-level connection errors
(pinned address refused, upstream reset) are not scope decisions and emit no
row — the allow row for that CONNECT already exists.

## Bypass coverage (the acceptance suite)

All five bypass classes run **live in the `test-docker` CI lane** (Phase
7.1, closing R1-6): each attempt is made against a real daemon and the
network layer refuses —

namespace escape (no NAT out of an `--internal` bridge; host-local INPUT
reachability is source-subnet-gated at the proxy and documented as a
residual) · **fd leak** (live: PID 1's descriptor table holds no sockets,
no `docker.sock` exists in the container, no `.sock` file anywhere, no raw
interface devices — plus the arg-vector proof that no host fd is ever
mounted) · **unix socket pass** (live: the daemon socket path is absent,
`/proc/net/unix` bridges nothing, the daemon's TCP ports at the gateway are
refused) · DNS-over-HTTPS through the proxy (a CONNECT to a DoH provider is
gated like any other destination; DoH resolution cannot create a
connection) · raw socket injection (garbage/non-CONNECT destroyed; raw
packets have no route) · cross-sandbox listeners (refused outside the
listener's own subnet — R1-1 regression) · plain-HTTP targets
(absolute-form forwarding, scope-checked per request — R1-4 regressions) ·
two-layer proof (an out-of-scope CONNECT with the tool layer bypassed is
still denied by the REAL policy — R1-18 regression) · rate pacing
(wall-clock throttling through the real policy — R1-18) · traffic companion
(a CONNECT tunnel carries real bytes end-to-end AND writes its audit row) ·
proxy down (provision refused).

## Residuals (owned, with target phases)

| Finding                                         | Severity | Reason                                                                                                                                                                                                        | Target Phase                                                           |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Host INPUT services reachable (R1-2)            | medium   | docker networking reality — `--internal` confines FORWARD, not INPUT; the proxy's own listeners are subnet-gated, other host services are not NYX's to firewall                                               | operator environment (DOCKER-USER rule below) / Phase 7 host hardening |
| The docker acceptance suite skips in CI (R1-6)  | medium   | **CLOSED Phase 7.1** — the `test-docker` lane runs the full suite against a real daemon (push to `main`, tags, docker-surface PRs, `docker`-labeled PRs); branch protection in `.github/BRANCH_PROTECTION.md` | closed                                                                 |
| URL-path scoping is invisible to CONNECT (R1-8) | low      | a CONNECT carries host:port only; for TLS the path is encrypted — the tool layer enforces paths; plain-HTTP paths ARE enforced via absolute-form                                                              | never (protocol limit)                                                 |
| Local provider = dev posture (R1-7)             | low      | production refuses the local provider entirely; unset NYX_ENV + local + engagement is the documented dev posture (tool layer as the only gate)                                                                | never (enforced boundary)                                              |
| Rebinding pin is 30 s cached (R1-12)            | info     | the cached answer is the VALIDATED pin — no window opens; a fresh resolve re-validates after TTL                                                                                                              | never (by design)                                                      |
| Tunnel can establish ≤15 s past expiry (R1-16)  | info     | the decision is authorization-time; the pinned connect has a 15 s ceiling                                                                                                                                     | never (bounded by design)                                              |

DOCKER-USER mitigation for R1-2 (operators who also want host services
unreachable from engagement bridges):

```
# Drop bridge traffic to host IPs except each bridge's own gateway:
iptables -I DOCKER-USER -i br-+ ! -d 172.16.0.0/12 -j DROP
```
