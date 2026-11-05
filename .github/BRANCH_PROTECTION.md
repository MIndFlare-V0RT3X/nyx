# Branch protection — the CI merge policy (Phase 7.1)

This file documents the required GitHub repository settings. Branch
protection lives in repository settings, not in git — an operator with admin
applies this once after the first push of `.github/workflows/ci.yml`.

## The two lanes

| Check | Runs on | Required for |
|---|---|---|
| `test-fast (hermetic)` | every push, every PR | **every PR merge** |
| `test-docker (bypass suite + security image)` | push to `main`, tags `v*`, PRs that touch the docker surface or carry the `docker` label | **every merge to `main`**; PRs outside the docker surface may merge on `test-fast` alone |

The docker surface (the `changes` job's path filter):

- `packages/sandbox/**`
- `packages/security/**`
- `Dockerfile.security`
- `.github/workflows/ci.yml`

Any PR touching those paths runs the docker lane automatically; any other PR
can opt in by adding the `docker` label (the `labeled` / `unlabeled` trigger
types re-evaluate the lane).

## Settings to apply (Settings → Branches → Branch protection rule)

Rule for `main`:

1. **Require a pull request before merging** — any number of approvals; the
   owner reviews their own work honestly or flags it.
2. **Require status checks to pass before merging**, with these required
   checks:
   - `test-fast (hermetic)`
   - `test-docker (bypass suite + security image)`
3. **Do not allow bypassing the above settings** (no admin bypass on red
   checks; `docker`-labeled or docker-surface PRs that cannot go green stay
   unmerged until fixed).

### About the docker check on non-docker PRs

When a PR does not touch the docker surface and has no `docker` label, the
`test-docker` job is **skipped** by its `if:` condition. GitHub treats a
check run skipped by a job-level condition as satisfying the required check,
so such PRs merge on `test-fast` alone — exactly the intended policy. If the
hosting organization's GitHub version behaves differently (very old
enterprise), the fallback is to drop `test-docker` from the required list and
rely on the `changes` job failing loudly when the docker surface is touched;
that is a strictly weaker posture and should be resisted.

## Local equivalents

- `pnpm exec turbo run test` — the hermetic lane (docker-gated tests
  auto-skip without a daemon; `NYX_SKIP_DOCKER=1` forces the skip even with
  a daemon present).
- With a local docker daemon and no `NYX_SKIP_DOCKER`, the same command is
  the docker lane, including the five live bypass proofs in
  `packages/security/src/scope/egress_docker.test.ts`.
- `docker build -f Dockerfile.security -t nyx-security:ci --build-arg
  TARGETARCH="$(dpkg --print-architecture)" .` — the security-image rebuild
  verification (the build fails on any tool-version drift).

## Cache discipline

Both lanes cache the pnpm store (`actions/setup-node` with `cache: pnpm`)
and the turbo cache (`.turbo`, keyed per lane). `NYX_SKIP_DOCKER` is part of
the turbo `test` task hash (`turbo.json` → `tasks.test.env`), so a hermetic
run can never be replayed as a docker-lane pass, or the reverse. The
`test-fast` target is **< 2 minutes on a warm cache**; the `test-docker`
target is **< 15 minutes**.
