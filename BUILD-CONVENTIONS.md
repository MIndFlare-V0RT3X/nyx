# NYX BUILD CONVENTIONS — read this before writing any code

You are contributing one package to the NYX monorepo: a local-first,
memory-first, security-first personal agent runtime (the harness, not the
model). This document is the working agreement. Your package prompt adds the
package-specific spec on top.

## Commands

- Build your package: `pnpm --filter @nyx/<pkg> build`
- Run your tests: `pnpm --filter @nyx/<pkg> test`
- Both must pass before you report back. (`test` = `vitest run`, non-watch.)

All runtime dependencies are **pre-declared** in each `package.json`. Do NOT
run `pnpm install`, `pnpm add`, or any command that mutates the lockfile. If
a dependency you need is missing, implement without it or report it as a
blocker in your final message.

## Hard rules

1. **Do not run any `git` command.** The integrator commits.
2. **Touch only your assigned package directory** (plus files your prompt
   explicitly lists). Never edit `packages/protocol` — it is the frozen
   contract. Never edit another package, even for a "small fix".
3. **ESM only.** Relative imports inside TS source MUST use the `.js`
   extension (`import { x } from "./util.js"`). The build is `module: NodeNext`.
4. **TypeScript strict.** No `any` in exported types. If unavoidable in a
   narrow internal spot, use `unknown` + narrowing instead.
5. **Every source file starts with the SPDX header**, first line:
   `// SPDX-License-Identifier: AGPL-3.0-or-later`
6. **Cross-package imports** go through `@nyx/<pkg>` (its `index.ts` exports)
   only. Never a deep path into another package.
7. **Typed errors.** Throw `Error` subclasses with a `code` property where a
   caller must distinguish outcomes. Never swallow errors silently; return
   typed results or throw.
8. **No I/O in `@nyx/protocol`-style pure modules** beyond what your spec
   says. Filesystem work in tests uses `os.tmpdir()` + `mkdtemp`, cleaned up
   in `afterAll`.
9. **Docker-dependent tests** must be skippable: wrap in a check that runs
   `docker version` (or honor `NYX_SKIP_DOCKER=1`) and use `it.skip`
   otherwise. Never let them fail on a machine without Docker.
10. **No secrets.** No real keys, no `sk-...` strings anywhere. Keys are env
    var _names_ referenced from config.
11. **Comments explain the non-obvious only.** No filler comments.
12. **Pino-style structured logging** where your spec asks for logs; never
    log secrets (see `@nyx/model` redaction conventions).

## Package layout (already scaffolded for you)

```
packages/<name>/
  package.json        # deps pre-declared — do not edit unless adding a dep is impossible to avoid (then report it)
  tsconfig.json       # typecheck config (noEmit), includes src + tests
  tsconfig.build.json # emit config → dist/, excludes *.test.ts
  vitest.config.ts    # include src/**/*.test.ts, environment node
  README.md           # you rewrite this: purpose, exports, usage, design notes
  src/index.ts        # public exports — this is the package's whole public surface
  src/...             # implementation + colocated *.test.ts
```

Build wiring: `tsconfig.json` extends `../../tsconfig.base.json` and sets
`noEmit: true`; `tsconfig.build.json` extends `./tsconfig.json`, sets
`noEmit: false`, `outDir: dist`, `rootDir: src`, `declaration: true`, and
excludes `src/**/*.test.ts`. The `build` script is
`tsc -p tsconfig.build.json`. This is already in place — keep it.

Vitest picks up `src/**/*.test.ts`. Use real assertions; one test file per
source module where practical. Cover every acceptance criterion in your
prompt with at least one test.

## Reading the frozen contract

`packages/protocol/src/index.ts` re-exports everything. Read the type files
under `packages/protocol/src/` before designing your implementation. If a
protocol type makes your spec impossible to implement, do NOT change
protocol — report it as a blocker with the specific type and what you need.

## README requirements

Every package README states: (1) what the package is for, one paragraph;
(2) its public exports with signatures; (3) a minimal usage example;
(4) design notes / invariants it enforces; (5) what is intentionally deferred
to a later phase.

## Report back

Your final message must contain, in this order:

1. **Built** — one line per module/feature.
2. **Verification** — the exact commands you ran (`pnpm --filter ... build`,
   `... test`) and their outcome with test counts.
3. **Deviations** — anything you did differently from your spec, and why.
   Write `none` if none.
4. **Blockers / questions** — protocol gaps, missing deps, ambiguities.
   Write `none` if none.
