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
   _names_ are declared in config. Tests use the mock provider.
4. **No telemetry.** The only outbound calls are to model providers the
   operator configured, and egress the operator's policy allows.
5. **Local-first.** Self-hosted, no phone-home, no accounts.

## Workflow

- pnpm 9 workspaces + Turborepo. Node 24 LTS (the `.nvmrc` pin) or 26
  (better-sqlite3 12.x prebuilds cover both; CI runs the fast lane on
  `[24, 26]`), 24 is what the tests are verified against.
- `pnpm install && pnpm build && pnpm test && pnpm lint` must pass from a
  clean clone before any PR. The SPDX audit runs with
  `node scripts/check-spdx.mjs` (CI runs it too).
- Conventional Commits: `feat(kernel): ...`, `test(session): ...`.
- Every package ships a README, a vitest suite, and exported types.
- Every source file carries `// SPDX-License-Identifier: AGPL-3.0-or-later`.

## CI (two lanes)

- **test-fast** — hermetic, every push and PR (`NYX_SKIP_DOCKER=1`); target
  < 2 min warm.
- **test-docker** — the full suite against a real docker daemon (the five
  live egress bypass proofs + the Dockerfile.security rebuild verification).
  Runs on `main`, tags, and PRs touching `packages/sandbox`,
  `packages/security`, `Dockerfile.security`, or the workflow — or carrying
  the `docker` label. Merge policy: `.github/BRANCH_PROTECTION.md`.
- Both lanes run the behavioral evals' baseline gate
  (`tests/evals/` — offline, no docker needed).

## Adding things

- **A skill** (`docs/SKILLS.md`): a SKILL.md with strict frontmatter under
  a scanned dir; progressive disclosure via the `load_skill` tool. The
  persona's own `skills/` dir joins the scan automatically.
- **A plugin** (`templates/plugin/`): copy the template, declare exactly
  the capabilities you exercise, generate a keypair, sign the manifest,
  and add the public key to `trusted-keys.json`. `nyx plugin audit <dir>`
  checks everything statically; the kernel re-verifies at load time and
  refuses untrusted or tampered code. The plugin set is host-only mutable.
- **A tool wrapper**: a ToolDefinition (zod-checked input, risk tier,
  capabilities) + handler; register it on the tool registry. Real binaries
  get a real-binary-format integration test — synthetic fixtures hide
  parsing bugs (the Phase 5 R3 lesson; Phase 7 §0.1's two-layer rule: a
  handler with a runtime wrapper ships a paired test through the runtime).
- **A behavioral eval** (`docs/EVALS.md`): a YAML spec with EVENT-LOG
  assertions, then `pnpm --filter @nyx/evals eval:update` to record the
  baseline — commit spec and baseline together.

## License

AGPL-3.0-or-later. By contributing you agree your contributions are licensed
under it.
