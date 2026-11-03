# Persona system

The persona is not a string. It is a directory of five files with a schema,
loaded once at session start and assembled into the system prompt
deterministically. Swapping the persona directory swaps the agent's voice,
contract, and operator profile — without touching the harness.

## Directory layout

```
personas/<id>/
  persona.yaml   # structured configuration (validated with Zod)
  SOUL.md        # who the agent is — voice, craft, values; carried verbatim
  CONTRACT.md    # the operator binding — a directive, not a suggestion
  USER.md        # the operator profile — name, timezone, standing instructions
  MEMORY.md      # human-readable index of durable memory (hand-maintained mirror)
```

- `persona.yaml` is validated by `PersonaSchema` (`@nyx/persona`); the four
  markdown files are carried **verbatim** into the prompt (trailing blank
  padding trimmed only).
- `MEMORY.md` is the readable mirror of durable memory. The machine index —
  the markdown files and SQLite FTS5 store owned by `@nyx/memory` — is the
  source of truth for retrieval; the prompt gets the catalog (titles + paths),
  and the assistant can open the underlying files with `fs.read`.
  Auto-appending lines to this mirror is deferred; prune it by hand.
- All five files are required. A missing file fails the load with the file
  path in the error; an invalid `persona.yaml` fails with the offending field
  paths (e.g. `persona.voice.register`). Persona ids are restricted to
  `[A-Za-z0-9][A-Za-z0-9._-]*` — no path traversal.

## `persona.yaml`

The shipped default (`personas/default/persona.yaml`):

- **Header** — `schema: 1`, `id`, `name`, `pronouns`, `tagline`.
- **`voice`** — `register` (`close | peer | cold`), `verbosity`
  (`terse | normal | expansive`), `humor`, `profanity`, `lowercase_in_chat`,
  `proper_case_in_deliverables`. The default is close, terse, dry.
- **`cognition`** — `planning` (`auto | always | never`), `self_check`,
  `cite_sources`, `verify_before_claim`, `state_uncertainty` (never bluff; say
  what is not known).
- **`contract`** — `precedence: operator_over_defaults`; `honesty`
  (`never_fabricate`, `evidence_required`, `no_completion_without_verification`);
  `scope` (`enforce_engagement`, `deny_out_of_scope`, `one_line_reason`);
  `escalate` (`irreversible`, `credential_use`, `host_access`,
  `network_egress_new_host`); `always` (`log_actions`, `verify_before_claim`,
  `preserve_scope`, `surface_material_risk`).
- **`capabilities`** — `domains` (e.g. `cyber.offensive`, `code.all`,
  `research.web`), `tools_allow`, `tools_deny`.
- **`memory`** — `auto_write`, `review_after_turn`, `scopes`.

Objects are `.passthrough()`: a newer persona file with extra fields still
loads (forward compatibility); unknown keys are kept, never dropped silently.

## Assembly order (fixed)

`SECTION_ORDER` in `@nyx/protocol` is frozen and not configurable;
`PersonaRuntimeImpl.buildSystemPrompt` maps builders over it, so the two
cannot drift. Each section becomes its own block — one system message per
section, so the model can tell contract from personality from context. No
persona content is ever concatenated into a single undifferentiated string.

| #   | Section           | Title            | Body                                                                                                                                                                                      |
| --- | ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `BASE_PREAMBLE`   | Harness          | the harness identity block: tool protocol, untrusted-content discipline, event discipline, honesty, scope                                                                                 |
| 2   | `CONTRACT`        | Contract         | one binding line, then `CONTRACT.md` verbatim                                                                                                                                             |
| 3   | `SOUL`            | Soul             | `SOUL.md` verbatim                                                                                                                                                                        |
| 4   | `USER`            | Operator Profile | `USER.md` verbatim                                                                                                                                                                        |
| 5   | `MEMORY_CATALOG`  | Memory           | one line per memory (title + path) — progressive disclosure, or "No memories indexed yet."                                                                                                |
| 6   | `SKILLS_CATALOG`  | Skills           | one line per skill (name, description, trigger), or "No skills installed."                                                                                                                |
| 7   | `TOOLS_CATALOG`   | Tools            | one line per tool: name, risk tier, description                                                                                                                                           |
| 8   | `SESSION_CONTEXT` | Session Context  | workspace facts (`- key: value`, keys sorted); when an engagement is bound, a three-line block last: id/authorizer/expiry, targets, and the statement that the harness enforces the scope |

Assembly is deterministic — no timestamps, no randomness; the same persona and
`PromptAssemblyInput` always produce byte-identical sections. The
golden-file test (`packages/persona/src/runtime.test.ts` against
`src/fixtures/golden-prompt.txt`) breaks loudly on any unintentional change
to `BASE_PREAMBLE`, the section format, or the default persona files.

## The contract philosophy

The default persona's stance, in the repo's own voice:

- **Character.** Terse, dry, evidence-first. "The output is the argument" —
  no filler, no self-narration, no moralizing. Findings carry their proof
  with them: the command, the output, the source, the reproduction steps.
  Being caught bluffing is worse than being caught wrong.
- **Scope discipline.** The contract **refuses out-of-scope targets in one
  line**, names the reason (out-of-scope target, expired engagement), and
  says what would authorize it — a new or amended engagement. This is not the
  persona's goodwill: scope is declared at session creation and enforced
  structurally by the policy and scope engines. The persona holds the line
  even under operator pressure mid-session, because the operator set it in
  the first place and changing it is an explicit, recorded decision.
- **Honest boundaries.** A real "no": one line, the reason, the nearest
  workable path. "If something is genuinely impossible, say so in one line
  and propose the nearest workable path." This is explicitly **not
  refusal-stripping**: nothing in the persona instructs the model to override
  its safety behavior. The contract instructs precision — evidence,
  verification, directness — and the model layer contains no
  refusal-detection or refusal-retry machinery to second-guess the model's
  judgment.

## Authoring a new persona

1. Copy `personas/default/` to `personas/<your-id>/` (id matching
   `[A-Za-z0-9][A-Za-z0-9._-]*`).
2. Edit the five files. `persona.yaml` must satisfy `PersonaSchema` (missing
   or invalid fields fail the load with field paths in the error); the
   markdown files are free prose.
3. Validate by loading — `loadPersona(personasRoot, id)` throws
   `PersonaLoadError` (code `validation_failed`) naming the missing file or
   the offending field. The golden test pattern in `packages/persona` is the
   template for snapshotting your assembled prompt.
4. Select it: set `persona.default_id: <your-id>` in `nyx.config.yaml`, or
   pass `persona_id` when creating a session. Swapping at runtime means
   loading another directory and constructing another runtime — a runtime is
   built from one loaded snapshot (hot-reload is deferred).

## How the persona reaches the model

`loadPersona` reads and validates the directory once → `PersonaRuntimeImpl`
takes the `LoadedPersona` → at each turn the loop calls
`buildSystemPrompt(PromptAssemblyInput)` with the live inputs (`session_facts`,
`memory_catalog`, `skills_catalog`, `tools_catalog`) → the returned
`PromptSection[]` is placed, in `SECTION_ORDER`, as separate system message
blocks ahead of the conversation. `assemblePromptText` (sections joined with
`## <title>` headers) exists for golden tests and debugging only; the kernel
consumes the sections directly.
