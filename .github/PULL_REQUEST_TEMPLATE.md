## What changes

One paragraph, the "why" before the "what".

## Where the behavior is proven

Every behavior change ships its proof:

- [ ] Unit tests (package + file)
- [ ] A behavioral eval if the harness's observable behavior changed
      (`tests/evals/` — and the baseline diff is intentional: yes/no)
- [ ] Docker-gated test if the sandbox/security surface changed
      (the `test-docker` lane runs it)

## The invariants

- [ ] No structural guarantee weakened (policy floor, scope, audit chain,
      sandbox containment — `docs/SECURITY-MODEL.md`)
- [ ] No new dependency without a note in the PR (BUILD-CONVENTIONS.md)
- [ ] SPDX header on every new source file (`node scripts/check-spdx.mjs`)
- [ ] `pnpm build && pnpm test && pnpm lint` green from a clean clone

## Residuals

If this narrows a guarantee or leaves a known gap: the residual row
(finding / severity / reason / target phase) in the relevant doc, and a
one-line headline in the README security model if it narrows a guarantee
(Phase 7 §0.2 discipline).
