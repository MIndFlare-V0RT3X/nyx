# Security Policy

## Threat model (Phase 0 baseline)

NYX runs an LLM-driven loop that can execute tools with side effects. The
assumed adversary is **prompt injection delivered through tool output and
untrusted content**, plus **operator mistakes on irreversible actions**. The
architecture counters both structurally, not by prompting:

- **Trust boundary.** Credentials live only in the kernel process. The agent
  loop holds no long-lived secrets; tool execution happens in a sandbox with
  no ambient authority and no host filesystem access.
- **Deny-first policy.** Every tool call is evaluated before execution:
  `deny > ask > allow`, risk tiers R0–R4. R4 always requires owner approval.
  Config cannot lower the floor on `host.access`, `credential.use`,
  `git.push`, or `deploy`.
- **Exact-action binding.** Approvals carry a sha256 digest of the canonical
  `{tool, input, risk}` triple. A mismatched action is rejected. Approvals
  expire after 10 minutes and are single-use.
- **Engagement scope.** Security-relevant network egress is checked against
  the session's immutable engagement scope (CIDR/domain targets with
  exclusions). Out-of-scope targets are denied, not escalated.
- **Path containment.** Every path a tool receives is resolved against the
  sandbox workdir; escapes are rejected before any handler runs.
- **Hash-chained audit.** Approvals, denials, and executions are recorded in
  a tamper-evident chain; verification detects modified rows.
- **Untrusted content discipline.** Tool output is delivered to the model
  wrapped in `<tool_output trust="untrusted">` markers and the preamble
  instructs the model to treat it as data, never instructions.

## Reporting a vulnerability

Report privately to the repository maintainer via GitHub security advisories
("Report a vulnerability"). Include reproduction steps, affected versions,
and impact. Do not open a public issue for security reports. You will receive
an acknowledgment within 7 days. Please avoid public disclosure until a fix
is released.

## Scope of this policy

Applies to this repository's code. Issues in third-party model providers or
sandbox runtimes should be reported to their upstream projects.
