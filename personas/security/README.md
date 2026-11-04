# Nyx Security persona

The security-engagement persona: run with `--persona security` (or set
`persona.default_id: security`) together with `--engagement
engagements/<id>.yaml`. The security skills are scoped to this persona;
sessions on other personas do not see them.

This persona adds nothing to Nyx's hard rules — it selects the posture:
scope-bound, evidence-first, report-oriented. The harness enforces the
scope engine regardless of persona; this persona simply expects to work
inside it.
