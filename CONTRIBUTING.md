# Contributing to NYX

NYX is a local-first, memory-first, security-first personal agent runtime —
the harness, not the model. See `docs/ARCHITECTURE.md` for the system design
and `BUILD-CONVENTIONS.md` for the working agreement every package follows.

## Ground rules

1. **The policy layer is frozen, the harness is editable.** Behavior changes
   are harness changes, measured against a baseline. Never weaken a structural
   invariant to make a feature work.
2. **Output separation.** The component being judged never writes the judgment.
   Agent code cannot edit the policy engine, its own audit log, or its
   verifier.
3. **No secrets in the repo.** Keys arrive via environment variables whose
   *names* are declared in config. Tests use the mock provider.
4. **No telemetry.** The only outbound calls are to model providers the
   operator configured, and egress the operator's policy allows.
5. **Local-first.** Self-hosted, no phone-home, no accounts.

## Workflow

- pnpm 9 workspaces + Turborepo. Node >= 22 (24 LTS recommended).
- `pnpm install && pnpm build && pnpm test && pnpm lint` must pass from a
  clean clone before any PR.
- Conventional Commits: `feat(kernel): ...`, `test(session): ...`.
- Every package ships a README, a vitest suite, and exported types.
- Every source file carries `// SPDX-License-Identifier: AGPL-3.0-or-later`.

## License

AGPL-3.0-or-later. By contributing you agree your contributions are licensed
under it.
