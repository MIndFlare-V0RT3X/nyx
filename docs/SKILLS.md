# Skills (Phase 4 §4.4)

Progressive disclosure for harness knowledge: a **skill** is a `SKILL.md`
(YAML frontmatter + Markdown body) whose frontmatter rides in the system
prompt's `SKILLS_CATALOG` section (~50–100 tokens per skill, curated under a
token cap) and whose body loads **on demand** through the R0 `load_skill`
tool — the same titles-only pattern the memory catalog uses. Skills are the
delivery surface the Phase 5 security subsystem will gate.

## The format

```markdown
---
name: deploy-runbook          # lowercase kebab-case, 1–64 chars
description: >                # 8–300 chars — the catalog line
  Step-by-step deploy procedure for the prod cluster.
when_to_use: deploying to production        # optional trigger hint
tools: [shell.exec, web.fetch]               # optional, INFORMATIONAL (Phase 4)
persona_scope: [sre, default]                # optional — only these personas
version: 1.2.0                               # optional, MAJOR.MINOR.PATCH
---

1. Freeze the lane queue …
```

- **`tools` is informational in Phase 4**: parsed, validated, surfaced in
  the catalog, and used to *filter the catalog by the session's real
  capabilities* — but it does NOT gate anything at runtime. Runtime tool
  gating is the Phase 5 security subsystem's job.
- A malformed skill is a **warning, never a session failure**: the entry is
  refused and logged (`skills.scan_warning`), the rest of the catalog loads.

## Where skills come from

Scanned in order (earlier wins on a name collision — the operator's dir
order IS the priority):

1. `skills.dirs` (default `~/.nyx/skills`) — shared bases, `~` expands;
2. `<persona_root>/<persona_id>/skills/` — the session persona's own skills,
   joined at scan time.

Both layouts work: flat (`<dir>/SKILL.md`) and package
(`<dir>/<skill-name>/SKILL.md`). The scan is cached per persona for the
process lifetime (personas and their skills load at startup cadence).

## The catalog

Built per session by the `context.initialize` hook, which rewrites exactly
the `SKILLS_CATALOG` section (the golden-tested section order is untouched;
the persona's own assembly renders an empty catalog first, exactly as the
memory catalog does before compaction indexing):

1. **filter** — persona scope (a `persona_scope`-declared skill only ships
   to its personas) and the session's **real capabilities**: a skill whose
   named tools require a capability the session cannot back (e.g.
   `net.egress` without an engagement — the tool runtime's scope check
   denies all egress there) is not advertised. Advertising work the session
   cannot do would be a prompt-injection-grade lie.
2. **curate** — under `skills.catalog_max_tokens` (default 2000): pinned
   skills first (in `skills.pinned` order), then most-recently-loaded, then
   alphabetical. Overflow **warns and names the drops**
   (`skills.catalog_overflow`) — the reference "82% vs 9%" finding means
   curation is not optional; the cap is what keeps disclosure progressive.

## The load_skill tool

```
load_skill({name}) → tool.result TEXT block with the skill's body
```

- **R0, `capabilities: []`** — a skill is trusted *content*, not a tool:
  loading its body grants no authority the session didn't already have.
- Every load lands on the session's event log as **`skill.loaded`**
  (name + version) — progressive disclosure, on the record.
- Re-loading in the same session → tool error `already_loaded` (the body is
  in the earlier tool result).
- A persona-scope or capability mismatch → `scope_mismatch`.
- Unknown name → `not_found`.

## Config

```yaml
skills:
  catalog_max_tokens: 2000     # min 200, max 20000
  dirs: ["~/.nyx/skills"]
  pinned: []                   # always in the catalog, in this order
  excluded: []                 # never advertised
```

## The golden test

`packages/skills/src/__golden__/system-prompt.txt` is the exact assembled
prompt for a fixture persona + skills dir, produced through the real
scan → filter → curate → render → hook-inject flow
(regenerate with `node --experimental-strip-types
scripts/generate-skills-golden.ts`). Any change to the section format or the
catalog line shape fails the golden test.
