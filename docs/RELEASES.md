# Release notes

Every tagged release of NYX is recorded here. The artifact hash below is
the authenticity anchor for its tarball — verify it before trusting a
download (the how-to is in each entry).

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
