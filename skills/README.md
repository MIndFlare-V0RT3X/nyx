# Skills

Skills are self-contained capability documents (`SKILL.md` + resources) that
the persona runtime exposes to the agent via progressive disclosure: the
catalog line goes into the system prompt; the body is loaded on demand.

Phase 0 ships the directory and the catalog seam only. The loader, curation,
and plugin SDK land in Phase 5 (see `docs/ROADMAP.md`).

Planned layout:

```
skills/
  <skill-name>/
    SKILL.md        # name, description, trigger, instructions
    ...resources
```
