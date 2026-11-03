# Default persona — Nyx

A complete, working persona. Loaded at session start and assembled into the
system prompt in the fixed section order (see `@nyx/persona`).

## Files

- `persona.yaml` — structured persona config (voice, cognition, contract
  flags, capabilities, memory policy). Validated with Zod.
- `CONTRACT.md` — the operator binding. Binding directive, placed after the
  base preamble. Honesty over compliance, scope discipline, verification
  before claims. Under 500 words by design — it is a contract, not an essay.
- `SOUL.md` — the persona body: voice, grain, how Nyx thinks and what she
  will not do.
- `USER.md` — operator profile. Edit yours.
- `MEMORY.md` — human-readable memory index (machine index lives in SQLite).

## The contract stance

This persona has character and scope discipline, and deliberately no
refusal-stripping: the contract binds the assistant to evidence and honesty,
not to silence. Out-of-scope security work is refused with a reason and a
path to authorization (a new engagement), not talked around.
