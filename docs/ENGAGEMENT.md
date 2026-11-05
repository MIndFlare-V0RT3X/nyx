# Engagement Files (Phase 5)

An engagement is the operator's signed authorization: what may be tested,
in which window, under which rate limits, and with which attack classes.
It is a YAML file (`engagements/<id>.yaml`, JSON also accepted — YAML is a
superset); `engagements/example.yaml` is a fully commented template using
RFC 5737/2606 documentation targets only.

## Lifecycle

- **Loaded at session creation** and bound to the session's owner
  (`operator_id` must match; a mismatch is a 400 `engagement_ownership`).
- **Immutable for the session's lifetime.** The loaded snapshot is what the
  session uses; editing the file mid-session is inert. Changing scope
  requires a new engagement and a new session.
- **Hash-pinned.** `loadEngagementYaml` records the file's sha256 and
  writes a `security.engagement.loaded` audit row (id, hash, window,
  techniques, warnings) through the audit sink.
- **CLI:** `nyx chat --engagement engagements/acme-q4-2026.yaml` (or
  `nyx run`). **Server:** `POST /v1/sessions` with the engagement object.

## Schema

```yaml
schema: 1
id: acme-q4-2026            # operator-facing reference
client: "Acme Corp"
operator_id: "owner"        # must match the session owner
signed_at: 2026-11-01T00:00:00Z
authorized_by: "Jane Smith, CISO"
emergency_contact: "security@acme.example"

window:                     # the authorization window
  start: 2026-11-01T00:00:00Z
  end: 2026-12-01T00:00:00Z

targets:
  domains: [example.com]    # suffix-anchored; "*.example.com" = strict subdomains
  cidrs: [203.0.113.0/24]   # authorizes raw IPs; required for resolved-address validation
  urls: ["https://app.example.com/portal/*"]   # scheme+host+path, exact subtree

exclusions:                 # ALWAYS wins over targets
  domains: [mail.example.com, "*.internal.example.com"]
  cidrs: [203.0.113.128/25]

rate_limits:                # per class + the shared default (see SECURITY-SUBSYSTEM.md)
  default: { requests_per_second: 10 }
  nmap: { packets_per_second: 100 }
  ffuf: { requests_per_second: 20 }

allowed_techniques:         # absent = none — unauthorized tools are absent from the registry
  - reconnaissance
  - port_scanning
  - web_enumeration
  - vulnerability_scanning
```

## Matching semantics

- **Domains** are suffix-anchored on dot boundaries: `example.com` matches
  `api.example.com` and the apex, never `notexample.com`. A wildcard entry
  (`*.example.com`) matches strict subdomains only, never the apex.
- **CIDRs** authorize raw IP literals; when any CIDR is declared, every
  resolved address of a target must fall inside one and outside every
  exclusion (the DNS-rebinding defense).
- **URLs** match structurally on scheme, host (exact), and path:
  `https://app.example.com/portal/*` matches `/portal` and everything
  under `/portal/`, never `/portalfoo` or `/admin/login`. URL entries
  authorize exactly their own host form — never a bare hostname.
- **Exclusions always win**, across classes: an excluded domain denies a
  URL target on that host; an excluded CIDR denies the IP inside an
  authorized range.
- **The window:** before `start`, every scope check denies with
  `engagement_not_yet_active`; at/after `end`, expired. A tool call that
  sleeps past `end` waiting for its rate bucket does not fire, and binary
  runtimes are capped to the remaining window. Reports are gated at each
  finding's *discovery* time (in-window), so writing the report after the
  window closes works.

## Techniques

`allowed_techniques` maps to the tool registry (see SECURITY-SUBSYSTEM.md):
`reconnaissance` (subfinder), `web_enumeration` (httpx, ffuf, katana),
`vulnerability_scanning` (nuclei), `port_scanning` (nmap). The contract
also defines `exploitation` and `social_engineering` — no Phase 5 tool maps
to them; they exist for Phase 6 tooling, which will additionally require
the escalation flow.

## Load-time validation

Unreadable, malformed, schema-invalid, or target-invalid files are refused
(`EngagementFileError`); an expired window is refused up front; a
not-yet-active window LOADS (the engine denies actions until it opens). A
domain-only engagement (no CIDRs) loads with a warning — resolved-address
validation cannot apply (the documented Phase 1 residual) — recorded on
the `security.engagement.loaded` audit row.
