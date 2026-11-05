# Release notes

Every tagged release of NYX is recorded here. The artifact hash below is
the authenticity anchor for its tarball — verify it before trusting a
download (the how-to is in each entry).

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
- `pnpm -r typecheck` clean, `pnpm lint` clean
- SPDX audit clean: 388/388 source files carry AGPL-3.0-or-later headers
  (`node scripts/check-spdx.mjs`)

### Artifact

- **`nyx-0.7.0.tar.gz`** — the tagged tree via `git archive` (content
  from commit `7d80056`, prefix `nyx-0.7.0/`, 691 files)
- **sha256**:
  `66fc0ec6efc6eed17ecf3a1a3c04acb453e7a9386a19311778c99bf67f461e21`

The archive is deterministic — rebuilding it from the same tag with
`git archive --format=tar.gz --prefix=nyx-0.7.0/ v0.7.0` reproduces the
same hash — so the value above is not just a fingerprint, it is a
reconstruction recipe.

Tag history (honest): `v0.7.0` was first cut at `fb2e7af`, then moved to
`7d80056` before any external publication — the CHANGELOG carried two
stale 387-counts and an overclaimed "signed" (the tag is annotated, not
GPG-signed). The pre-correction archive of `fb2e7af` hashes to
`905d283c9a1942bb688903b2bc6848b88b149c12c417e98cc83342b71130bae5`; it
is listed here only so the move is visible, not as a second artifact.

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
signing key exists, the tarball sha256 above is the authenticity anchor:
the tag names the commit, the commit builds the archive, the archive
hashes to this value. A future release with a configured key will carry
a GPG-signed tag and this note will say so.

### Known residuals at release

The guarantees that end where the docs say they end — the full ledger is
`docs/SECURITY-MODEL.md`; the headline (the docker `--internal`
host-INPUT residual and its DOCKER-USER mitigation) is the first
section of the README. Notable at 0.7.0: the host INPUT path is not
firewalled by NYX (operator DOCKER-USER rule documented), OS-level
process isolation is Phase 8 deployment work (`docs/PROCESS-MODEL.md`),
and IPC tokens are per-process rather than per-connection (documented
residual; protocol v2).
