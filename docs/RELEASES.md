# Release notes

Every tagged release of NYX is recorded here. The artifact hash below is
the authenticity anchor for its tarball — verify it before trusting a
download (the how-to is in each entry).

## v0.7.4 — 2026-11-07 — the docker-case patch

From reading the CI conclusions nobody had read: the `test-docker` lane
had been red on every run it ever had — v0.7.1, v0.7.2 and v0.7.3 all
shipped without its verdict being checked (the local gate has no docker
daemon; the 21 docker-gated tests run only on the CI daemon, and the
release ritual verified pushes — ls-remote, release asset digests —
without ever reading the Actions conclusions). The failure was
deterministic and one line deep, in the class the previous three
patches were hunting: an assumption about the environment, this time
Docker's naming contract rather than the machine's speed.

What shipped:

- **The fork temp image is a valid docker repository reference** —
  `DockerSandbox.fork()` tagged the parent commit
  `nyx-fork-${nanoid()}`; nanoid's default alphabet is mixed-case and
  docker repository references are lowercase-only, so `docker commit`
  died with `invalid reference format: repository name
(library/nyx-fork-…) must be lowercase` on all but ~0.001% of 21-char
  draws (both ids the CI lane ever printed drew uppercase).
  `forkImageName()` now draws from a lowercase-only alphabet
  (36^21 ≈ 2^109 ids); container names (`nyx-sbx-…`) and network names
  (`nyx-egress-…`) keep nanoid — different contracts that allow mixed
  case. The fork temp image was the only image-reference construction
  in the tree.
- **A hermetic regression line** — the name is asserted lowercase-only
  in the no-daemon describe block of `docker.test.ts`, so the fast
  lane holds the fix on every push.
- **Docs** — TOOLING-NOTES gotcha #7: docker repository references are
  lowercase-only, and a release is not done when the push lands — it is
  done when the CI conclusions are green.

### Gate at tag time

- 48/48 turbo tasks on Node 24.22.2 (the .nvmrc pin) — 1320 tests
  (1299 passing + 21 docker-gated) in the hermetic lane
- The Node 26 fast-lane leg and the docker lane verified on GitHub
  Actions after the push, conclusions checked — the step the previous
  three releases skipped
- typecheck, lint, format:check, SPDX 393/393, check-bins 4/4 clean

### Artifact

- **`nyx-0.7.4.tar.gz`** — the tagged tree via `git archive` (content
  from commit `4909a52`, prefix `nyx-0.7.4/`, 701 files)
- **sha256**: `4c929c5572428e23f28e966d2187dbe9ec74e7b41e226334b6b140657fefc0d2`
  (recorded here at the `main` tip; a tree cannot contain the hash of
  its own archive — the hash covers the bytes that would include it —
  so the tagged copy of this file points at the tag annotation, the
  GitHub release body, and this section instead)

The archive is deterministic — `git archive --format=tar.gz
--prefix=nyx-0.7.4/ v0.7.4` reproduces it byte-for-byte. As before,
GitHub's auto-generated "Source code (tar.gz)" uses its own archiver and
will not match; the release asset is canonical.

Signing note: the `v0.7.4` tag is annotated, not GPG-signed (no signing
key is configured in the build environment — same honest posture as
v0.7.0 through v0.7.3). The tarball sha256 is the authenticity anchor.

`v0.7.0` through `v0.7.3` and their artifacts are untouched.

## v0.7.3 — 2026-11-06 — the slow-machine patch

From a third first-run report (the same WSL2 machine, now on a fresh
v0.7.2 tarball — install clean, zero bin warnings, build and typecheck
green): the suite failed at `@nyx/subagents` with
`R4-1: the LRU reap NEVER destroys a still-running child's sandbox`, and
the CLI/server integration tests straggled at 20–32 s against a 30 s
ceiling, the same test failing one run and passing the next. The code was
correct everywhere; every failure was a machine-speed assumption — the
class v0.7.1 started hunting, now finished for the integration suites.
The release gate then caught a second, worse assumption while verifying:
engagement fixtures anchored to absolute calendar dates — one already
expired at noon UTC on release day, another scheduled to detonate on
2026-12-01.

What shipped:

- **R4-1, event-driven** — the test's "still-running child" was held open
  by a fixed 500 ms-per-turn sleep that assumed the eight fill-spawns
  settle inside ~1 s; on a box where a spawn takes ~2 s the child settled
  early and the LRU reap LEGALLY evicted it (`not_found … reaped past the
retention cap`). The harness provider gained `gated()` — the child's
  first model turn blocks on a test-held promise — so "still running" is
  an event the test controls, and the test now asserts the mid-flight
  invariant directly (the gated child is STILL running after the storm
  that provably triggered the reap). The failure was reproduced
  deterministically under simulated slow-fork conditions; the rewrite
  passes under the same conditions.
- **The calendar time bombs** — engagement fixtures anchored to absolute
  dates: the exploitation/integration windows expired at
  2026-11-06T12:00:00Z (two hours after v0.7.2 shipped; 13 tests failed
  on every later run — the tools runtime's scope verdict checks the
  window against the real clock, which the rigs' frozen clocks cannot
  influence) and the report generator's was scheduled for 2026-12-01.
  Default fixture windows are now real-clock-anchored (always active for
  a run's lifetime); expiry-mechanism tests still override the window
  explicitly. Found by this release's own gate, not by a user.
- **The last wall-clock upper bound in the touched suites** — the
  non-interactive-approval test asserted the whole turn finishes in
  <10 s. Gone; the grace lower bound (a can-only-fire-late timer) stays
  as a safety property.
- **Machine budgets, sized for the slowest supported machine** —
  `testTimeout`/`hookTimeout` 30 s → 120 s for cli, server, subagents and
  security (e2e 60 s → 120 s), and every `until()` poll budget 8–10 s →
  60 s. Deadlines that exist to catch hangs are not correctness
  assertions.
- **Docs** — TOOLING-NOTES gotchas #5 (ceilings and poll budgets are
  machine budgets; "still running" is an event, not a duration) and #6
  (absolute calendar dates in fixtures are time bombs).

### Gate at tag time

- 48/48 turbo tasks — 1319 tests (1298 passing + 21 docker-gated) on
  Node 24.22.2 and Node 26.13.0, per-package counts identical across both
- Verified twice: on the dev tree and on a fresh tarball extraction
  running the exact README quickstart sequence
- The slow-machine condition reproduced (R4-1 fails on the old shape
  under simulated 4× fork latency) and verified gone (the rewrite passes
  under the same conditions)
- The time bombs verified: the suite runs green with the real clock past
  the old fixtures' expiry (2026-11-06T12:00Z)
- typecheck, lint, format:check, SPDX 393/393, check-bins 4/4 clean

### Artifact

- **`nyx-0.7.3.tar.gz`** — the tagged tree via `git archive` (content
  from commit `f148fed`, prefix `nyx-0.7.3/`, 701 files)
- **sha256**: `382291fff89790ec89d55a2942231dd4f4f2638240fde7b46ab85ce332fd2e02`
  (recorded here at the `main` tip; a tree cannot contain the hash of its
  own archive — the hash covers the bytes that would include it — so the
  tagged copy of this file points at the tag annotation, the GitHub
  release body, and this section instead)

The archive is deterministic — `git archive --format=tar.gz
--prefix=nyx-0.7.3/ v0.7.3` reproduces it byte-for-byte. As before,
GitHub's auto-generated "Source code (tar.gz)" uses its own archiver and
will not match; the release asset is canonical.

Signing note: the `v0.7.3` tag is annotated, not GPG-signed (no signing
key is configured in the build environment — same honest posture as
v0.7.0/v0.7.1/v0.7.2). The tarball sha256 is the authenticity anchor.

`v0.7.0`, `v0.7.1` and `v0.7.2` and their artifacts are untouched.

## v0.7.2 — 2026-11-06 — the install-hygiene patch

From a second first-run report (Kali Linux, fresh v0.7.1 tarball):
`pnpm install` printed three pairs of `WARN Failed to create bin …
ENOENT` warnings and left the `nyx-kernel` / `nyx-agent` / `nyx-tools`
shims missing. The install was healthy — the bins pointed at `dist/`
build output, which cannot exist before the first build, and pnpm links
package bins at install time and never retries after `pnpm build`.

What shipped:

- **Committed bin launchers** — the split and CLI bin entries now point
  at committed stubs (`apps/split/bin/`, `apps/cli/bin/`) that spawn the
  build output at runtime (spawn, never import: the mains run `main()`
  at module load). Pre-build the launchers exit 1 with a plain-language
  "run `pnpm install && pnpm build` first"; post-build the commands
  behave exactly like `node apps/split/dist/*.js`.
- **`scripts/check-bins.mjs`** — the class-killer guard: every workspace
  `bin` must point at a git-tracked file; wired into the `test-fast` CI
  lane.
- **Docs** — TOOLING-NOTES gotcha #4; PROCESS-MODEL notes the package
  bins.

### Gate at tag time

- 48/48 turbo tasks — 1319 tests (1298 passing + 21 docker-gated)
- Verified twice: on the dev tree and on a fresh tarball extraction
  running the exact README quickstart sequence — zero bin warnings,
  shims present and functional pre- and post-build, build 25/25,
  typecheck clean
- typecheck, lint, format:check, SPDX 393/393, check-bins 4/4 clean

### Artifact

- **`nyx-0.7.2.tar.gz`** — the tagged tree via `git archive` (content
  from commit `1a8b200`, prefix `nyx-0.7.2/`, 701 files)
- **sha256**: `35feef7c34f77dbe3792a86c39e8bdc255d03e5d41339eb4dfdb6e19e37969ba`
  (recorded here at the `main` tip; a tree cannot contain the hash of its
  own archive — the hash covers the bytes that would include it — so the
  tagged copy of this file points at the tag annotation, the GitHub
  release body, and this section instead)

The archive is deterministic — `git archive --format=tar.gz
--prefix=nyx-0.7.2/ v0.7.2` reproduces it byte-for-byte. As before,
GitHub's auto-generated "Source code (tar.gz)" uses its own archiver and
will not match; the release asset is canonical.

Signing note: the `v0.7.2` tag is annotated, not GPG-signed (no signing
key is configured in the build environment — same honest posture as
v0.7.0/v0.7.1). The tarball sha256 is the authenticity anchor.

`v0.7.0` and `v0.7.1` and their artifacts are untouched.

## v0.7.1 — 2026-11-06 — the machine-assumption patch

A first-run user report became this release: on Node 24.22.2 / WSL2 the
harness installed, built, typechecked, and ran 39/48 turbo tasks green —
the one failure was `expect(appendMs).toBeLessThan(5000)` in the session
replay suite failing at ~28.5 s with the store itself completely correct.
The code was right; the assertion was written against the dev machine.

What shipped:

- **Timing-bound removal (the reported failure)** — the redundant 10k
  scale block in `replay.test.ts` (which carried the two wall-clock
  bounds) is deleted; its unique ground-truth count assertions moved into
  `replay-10k.test.ts`, the canonical 10k test: byte-identity of
  projections across replay, now checked against the generator's expected
  counts too. Timings are logged, never asserted.
- **better-sqlite3 ^11.8.1 → ^12.11.1** — prebuilds for Node 24 and 26;
  installs drop from a ~4-minute source build to seconds on both.
- **The hardcoded-perf-bound audit** — every large numeric
  `toBeLessThan/OrEqual` in the suite classified correctness vs
  machine-speed assumption. The two deleted session assertions were the
  only machine-speed assumptions. Kept as correctness: the sandbox
  kill-promptness bounds (a wall-clock kill that never completes is a
  broken sandbox) and the approval-TTL bounds (semantic
  `createdAt + ttl` arithmetic). Full table in the GitHub release body.
- **CI Node matrix** — `test-fast` on `[24, 26]`; `test-docker` on 24.
- **README quickstart leads with the Node requirement**; new
  `docs/TOOLING-NOTES.md` (WSL2 timing, the `[m`/`[0m` display artifact,
  prebuild coverage).

### Gate at tag time

- 48/48 turbo tasks on **both** Node 24.22.2 and Node 26.13.0 — 1319
  tests each (1298 passing + 21 docker-gated), identical per-package
  counts
- typecheck, lint, format:check, SPDX (388/388) clean

### Artifact

- **`nyx-0.7.1.tar.gz`** — the tagged tree via `git archive` (content
  from commit `697f43f`, prefix `nyx-0.7.1/`, 694 files)
- **sha256**: `7ac0ab5c969a7ee4099506f8b77d4756b463f6532c7a6f5db108c9a958cb7ead`
  (recorded here at the `main` tip; a tree cannot contain the hash of its
  own archive — the hash covers the bytes that would include it — so the
  tagged copy of this file points at the tag annotation, the GitHub
  release body, and this section instead)

The archive is deterministic — `git archive --format=tar.gz
--prefix=nyx-0.7.1/ v0.7.1` reproduces it byte-for-byte. As with v0.7.0,
GitHub's auto-generated "Source code (tar.gz)" uses its own archiver and
will not match; the release asset is canonical.

Signing note: the `v0.7.1` tag is annotated, not GPG-signed (no signing
key is configured in the build environment — same honest posture as
v0.7.0). The tarball sha256 is the authenticity anchor.

`v0.7.0` and its artifact are untouched by this release.

## v0.7.0 — 2026-11-06 — the first publishable release

Phases 0–7 complete and feature-complete against the original roadmap:
foundation (config, policy broker, audit chain, session event logs),
channels, the unified SQLite store, subagents, durable tasks + skills,
the security subsystem (engagements, three-layer scope, findings,
reports), the egress proxy + exploitation toolkit + CVE disclosure
workflow, and release readiness (two-lane CI, plugin trust, the kernel /
agent / tools process split, behavioral evals). `CHANGELOG.md` has the
full detail; `docs/ROADMAP.md` has the phase history.

### Gate at tag time

- 48/48 turbo tasks (build + test across all packages)
- 1320 tests: 1299 passing + 21 docker-gated bypass proofs (the bypass
  proofs run live in the `test-docker` CI lane; locally without a docker
  daemon they skip, by design)
- `pnpm -r typecheck` clean, `pnpm lint` clean, `pnpm format:check` clean
- SPDX audit clean: 388/388 source files carry AGPL-3.0-or-later headers
  (`node scripts/check-spdx.mjs`)

### Artifact

- **`nyx-0.7.0.tar.gz`** — the tagged tree via `git archive` (content
  from commit `8058eb8`, prefix `nyx-0.7.0/`, 693 files)
- **sha256**: `06aa4c621cb02e13cb4af39ca0eed7e3add1335fa2051f6e9732dc0091957040`
  (recorded here at the `main` tip; the tagged tree cannot contain the
  hash of its own archive — the hash covers the bytes that would include
  it — so the tagged copy of this file points at the tag annotation, the
  GitHub release body, and this section instead)

The archive is deterministic — rebuilding it from the same tag with
`git archive --format=tar.gz --prefix=nyx-0.7.0/ v0.7.0` reproduces the
same hash — so the published value is not just a fingerprint, it is a
reconstruction recipe.

Tag history (honest): `v0.7.0` was cut three times, all before any
external publication:

1. at `fb2e7af` — the first cut (archive hashes to
   `905d283c9a1942bb688903b2bc6848b88b149c12c417e98cc83342b71130bae5`);
2. at `7d80056` — the CHANGELOG carried two stale 387-counts and an
   overclaimed "signed" (the tag is annotated, not GPG-signed)
   (archive hashes to
   `66fc0ec6efc6eed17ecf3a1a3c04acb453e7a9386a19311778c99bf67f461e21`);
3. finally at `8058eb8` — to fold in the repo-wide prettier
   normalization (`e54c66d`, 211 files, provably inert: the full fresh
   suite ran identical counts, 1299 passing + 21 docker-gated = 1320,
   before and after) so the artifact matches the repo tip.

The earlier archives are listed so the moves are visible, not offered as
alternate artifacts.

Verify a download against it:

```sh
sha256sum nyx-0.7.0.tar.gz   # must print the hash above
```

Build and test from the tarball:

```sh
tar xzf nyx-0.7.0.tar.gz && cd nyx-0.7.0
pnpm install --frozen-lockfile
pnpm exec turbo run build && pnpm -r typecheck
NYX_SKIP_DOCKER=1 pnpm exec turbo run test   # hermetic lane
```

### Signing note (honest)

The `v0.7.0` tag is an **annotated** tag — no GPG key is configured in
this environment, so it carries no cryptographic signature. Until a
signing key exists, the tarball sha256 is the authenticity anchor:
the tag names the commit, the commit builds the archive, the archive
hashes to the published value. A future release with a configured key
will carry a GPG-signed tag and this note will say so.

### Known residuals at release

The guarantees that end where the docs say they end — the full ledger is
`docs/SECURITY-MODEL.md`; the headline (the docker `--internal`
host-INPUT residual and its DOCKER-USER mitigation) is the first
section of the README. Notable at 0.7.0: the host INPUT path is not
firewalled by NYX (operator DOCKER-USER rule documented), OS-level
process isolation is Phase 8 deployment work (`docs/PROCESS-MODEL.md`),
and IPC tokens are per-process rather than per-connection (documented
residual; protocol v2).
