# NYX

> A local-first, memory-first, security-first personal agent runtime.
> The harness, not the model.

NYX turns a stateless LLM into a stateful operator: sessions persist across
restarts as append-only event logs, tools execute inside sandboxes behind a
deny-first policy broker, memory is markdown you can read, and the persona is
a first-class directory of files with an honest operator contract.

**Status:** Phase 0 (foundation). See `docs/ROADMAP.md`.

## Quickstart

```bash
pnpm install
pnpm build
NYX_MOCK=1 pnpm --filter @nyx/cli exec node dist/main.js run "hello" --mock
```

Or wire the CLI into your PATH after `pnpm build`:

```bash
pnpm install && pnpm build
pnpm --filter @nyx/cli exec node dist/main.js doctor
```

Full quickstart, config reference, and architecture: see `README.md` (final
pass lands with Phase 0 docs polish in `docs/`).

## Layout

- `packages/protocol` — frozen shared contracts (types + boundary Zod schemas)
- `packages/config`, `kernel`, `session`, `model`, `scope`, `policy`,
  `sandbox`, `tools`, `memory`, `persona`, `agent`
- `apps/server`, `apps/cli`, `apps/web`
- `personas/default` — the default persona (Nyx)
- `tests/e2e` — smoke, approval, replay, scope

## License

AGPL-3.0-or-later. See `LICENSE`.
