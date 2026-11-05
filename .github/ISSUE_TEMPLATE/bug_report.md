---
name: Bug report
about: Something behaved wrong — crashes, wrong events, security-relevant oddities
labels: bug
---

**What happened?**

A clear description of the wrong behavior. If a tool call was involved,
the session event log is the fastest way for us to see what the harness
actually did (`nyx sessions show <id>` / `GET /v1/sessions/:id/events`).

**What did you expect?**

**Reproduction**

Steps, config (redact tokens — never paste real credentials), persona id,
and the NYX version (`nyx doctor` prints it; or the tag you run from).

- Mode: single-process / split (`NYX_PROCESS_MODE`)
- Sandbox: local / docker
- Engagement file, if security tooling was involved (scope matters)

**Logs / events**

```
paste the relevant event log or audit rows
```
