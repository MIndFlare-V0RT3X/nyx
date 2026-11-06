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

## 5. Timeout ceilings and poll budgets are machine budgets, not assertions

**Symptom:** on a slow box (WSL2 under suite load), heavyweight
integration tests fail with `Test timed out in 30000ms` or
`until: condition not met in time` while the same tests pass on CI — and
the failing set differs run to run (the v0.7.3 report: the same CLI test
failed in one run at ×30701 ms and passed in the next at ✓24030 ms;
natural durations on the slow box were 20–32 s against a 30 s ceiling).

**Cause:** the ceilings (vitest `testTimeout`/`hookTimeout` at 30 s) and
the poll budgets (`until()` defaults of 8–10 s) were sized against fast dev
hardware. The integration suites build real runtimes — SQLite WAL with
`synchronous=FULL` fsync per event batch, sandbox forks (`cp -a`), loopback
servers — whose natural durations scale 3–5× on WSL2 (gotcha #1). A
ceiling calibrated to a fast machine is a machine-speed assumption wearing
an infra hat: it converts "slow but correct" into "failed".

**Rule:** a deadline that exists to catch a hang is a machine budget —
size it for the slowest supported machine (120 s ceilings and 60 s poll
budgets in the heavyweight suites as of v0.7.3), never tighten it to make
a failure easier to see, and never treat hitting it as a correctness
signal. What a test _asserts_ stays on values, identities, and counts
(gotcha #1's rule); the one sanctioned pattern for bounding time — a lower
bound on a can-only-fire-late timer (e.g. the auto-deny grace) — is a
safety property and carries a headroom comment. And in concurrency tests,
"still running" must be an event the test controls (a gate the test
releases), never a duration the machine grants — the R4-1 lesson: a fixed
500 ms hold silently assumed eight fork-spawns settle inside ~1 s, and on
a box where a spawn takes ~2 s the reap LEGALLY evicted the "running"
child after it settled early.

## 6. Absolute calendar dates in fixtures are time bombs

**Symptom:** a suite that was green at release time starts failing en
masse hours or days later with `denied by scope: engagement expired at
2026-11-06T12:00:00.000Z` — 13 security-tool tests failed on every run
after that instant, two hours after the v0.7.2 tag; the report
generator's fixture had the same failure scheduled for 2026-12-01.

**Cause:** the test rigs inject a frozen clock into THEIR components
(store, limiter, resolver, engine), but code under test legitimately
consults the REAL clock in places the rig does not control — the tools
runtime's scope verdict checks engagement windows against `Date.now()`,
and `generateReport` defaults to `Date.now()` when the test omits `now`.
An engagement fixture anchored to an absolute calendar instant is checked
against the real calendar whether the rig likes it or not.

**Rule:** a fixture time window that must be ACTIVE must be anchored to
the real clock at run time — `starts_at` frozen safely in the past (so
the rig's own frozen clock sits inside the window) and `expires_at` at
`Date.now() + <outliving any test run>` — never to a frozen absolute
instant. Frozen absolute timestamps are fine only for fields that nothing
outside the rig reads (deterministic rendering), and a test that
exercises the expiry mechanism overrides `expires_at` explicitly.
`Date.UTC(202…)` as a window end in a fixture is a scheduled outage. The
audit that classified every such fixture lives in the v0.7.3 release
notes; the fully-injected frozen-clock unit suites (scope engine,
matcher, rate limiter — `NOW = 1_700_000_000_000`) are legitimately
absolute, and cron's `nextFire` is a pure function of its input instant.

## 7. Docker repository references are lowercase-only — and a release is not done until the CI conclusions are green

**Symptom:** the `test-docker` CI lane fails in ~60 s at
`DockerSandbox.fork` with

```
Error: docker commit (fork) failed (exit 1): invalid reference format: repository name (library/nyx-fork-…) must be lowercase
```

— on every run the lane ever had: v0.7.1, v0.7.2 and v0.7.3 all shipped
with it red. No dev machine has a docker daemon (the 21 docker-gated
tests run only in CI), and the release ritual verified the push —
ls-remote, release asset digests — without ever reading the Actions
conclusions.

**Cause:** two naming contracts were conflated. Container names
(`nyx-sbx-…`) and network names (`nyx-egress-…`) follow
`[a-zA-Z0-9][a-zA-Z0-9_.-]*` and may be mixed-case; image repository
references (the targets of `docker commit`/`tag`/`push`) allow only
lowercase. `fork()` built the temp image as `nyx-fork-${nanoid()}` and
nanoid's default alphabet is mixed-case — an uppercase byte appears in
all but ~(36/62)^21 ≈ 0.001% of 21-char draws, so the tag was rejected
essentially every time it met a real daemon.

**Rule:** anything handed to `docker commit`/`tag`/`push` as a
repository name is generated from a lowercase-only alphabet
(`forkImageName()` draws `0-9a-z`, and a hermetic test holds that line
so the fast lane catches a regression). Container and network names
keep nanoid. And the process rule, the expensive half of this gotcha:
a release is not done when the push lands — it is done when the CI
conclusions are green. Push-time checks prove delivery, not health; a
surface that runs only in CI (the daemon lane) is evidenced only by
its lane's conclusion.
