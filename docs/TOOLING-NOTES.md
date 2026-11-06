# Tooling notes

Hard-won lessons about the environments this repo runs in — read before
writing a test that asserts on time, or before declaring a file broken
because it "looks" wrong in a terminal. Add entries here when a gotcha
costs more than ten minutes to diagnose; each one should name the symptom,
the cause, and the rule that prevents a repeat.

## 1. WSL2 file-backed tests are 3–5× slower than native Linux

**Symptom:** a wall-clock assertion that passes comfortably on the dev
machine (native Linux, NVMe) fails on a contributor's laptop with the code
completely correct — e.g. v0.7.0's "scales to 10,000 events … within a few
seconds" failed at ~28.5 s on Node 24.22.2 / WSL2 with a healthy store
(the same workload's identity test passed everywhere).

**Cause:** WSL2's 9p/virtio filesystem layer makes file-backed SQLite
writes (and small-file I/O generally) 3–5× slower than native ext4. A
bound calibrated with 5× headroom on native hardware has none left.

**Rule:** never assert absolute wall-clock bounds in tests. Timing is a
cost concern — `console.log` it for CI visibility (see
`packages/session/src/replay-10k.test.ts`) — while correctness assertions
stay on values, identities, and counts. If a test must bound time to prove
a _mechanism_ (e.g. a sandbox kill actually happens), the bound belongs to
the safety property, must carry large headroom, and gets flagged in the
test's comment. The audit that established this lives in the v0.7.1
release notes.

## 2. The display channel eats `[m` and `[0m`

**Symptom:** a YAML/TS file that renders fine in an editor displays as
broken — e.g. `.github/workflows/ci.yml`'s `branches: ain]` — and a
maintainer wastes an hour "fixing" a file that was never damaged.

**Cause:** `ESC [ m` and `ESC [ 0 m` are zero-argument ANSI SGR reset
sequences. Any tool or terminal channel that strips or interprets escape
codes will silently consume the literal two/three-character sequences
`[m` / `[0m` from _output_, turning `[main]` into `ain]`.

**Rule:** before reporting a file as broken based on what a terminal (or
an agent's tool output) shows, verify the bytes — `cat -A`, `xxd`, or
`od -c` on the exact line. Byte-level evidence outranks rendered output.
(Learned during the Phase 7 publish: a "release blocker" in the CI
workflow was a display artifact; the hex dump acquitted it.)

## 3. `better-sqlite3` prebuilds are version- and Node-major-specific

**Symptom:** `pnpm install` takes ~4 minutes and prints a node-gyp build
log on a machine that should have gotten a prebuilt binary; on other
machines the same install takes seconds.

**Cause:** `better-sqlite3` 11.x ships no prebuild for Node 24 — every
Node 24 install builds from source (toolchain: python3, make, g++). 12.x
ships prebuilds for both Node 24 and 26; v0.7.1 bumped to `^12.11.1` so
installs drop to seconds on both (verified: the v0.7.1 CI matrix runs
`test-fast` on Node 24 and 26).

**Rule:** when a native dependency changes (version bump, new Node
major), check `prebuilds/` coverage for the _exact_ Node majors you
support before assuming the install is fast — and keep the Node support
matrix in CI (`test-fast` on `[24, 26]`) so an "only works on one Node
version" assumption fails a check instead of a user.

## 4. Package `bin` entries link at INSTALL time — point them at committed files

**Symptom:** a fresh `pnpm install` (before the first build) prints three
pairs of warnings —

```
WARN Failed to create bin at …/node_modules/.bin/nyx-kernel. ENOENT: no such file or directory, open '…/apps/split/dist/kernel-main.js'
```

— and the install still succeeds, which understates the damage: the
`nyx-kernel` / `nyx-agent` / `nyx-tools` shims are left MISSING, and pnpm
never retries the links after `pnpm build` (reported by a first-run user
against v0.7.1, on a fresh tarball extraction).

**Cause:** pnpm links a package's `bin` entries into dependents'
`node_modules/.bin` during install — before any build output exists. The
split (and CLI) bins pointed at `dist/*.js`, which a fresh clone cannot
have yet.

**Rule:** every `bin` target must be a file git tracks. The entrypoints
are committed launcher stubs (`apps/split/bin/`, `apps/cli/bin/`) that
spawn the build output at runtime — kernel/tools mains run `main()` at
module load and block until signalled, and agent-main's import guard keys
off `argv[1]`, so the launchers spawn (never import) the entries.
`scripts/check-bins.mjs`, wired into the `test-fast` CI lane, fails the
build on any bin that points at a missing or untracked file.
