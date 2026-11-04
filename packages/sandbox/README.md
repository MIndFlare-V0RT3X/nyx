# @nyx/sandbox

Sandboxed execution for NYX tool runs, per `@nyx/protocol`'s `Sandbox` /
`SandboxProvider` contracts: provision a throwaway working directory, run
commands in it, read/write/list files, tear it down. The package ships two
providers — **local** (development only, no isolation beyond path
containment) and **docker** (Phase 0: `--network none` containers driven
through the `docker` CLI) — plus the centralized path-containment helpers
that `@nyx/tools` reuses for its file tools.

## Public exports

```ts
// paths.ts — centralized path containment (reused by @nyx/tools)
class PathEscapeError extends Error {
  code: "path_escape";
}
function resolveContained(workdir: string, target: string): string;
function assertRealpathContained(workdir: string, target: string): Promise<string>;

// local.ts — DEVELOPMENT ONLY
class LocalSandboxProvider implements SandboxProvider {
  constructor(opts?: { root?: string; force_prod?: boolean }); // root defaults to ~/.nyx/sandboxes
  readonly id: "local";
  provision(spec: SandboxSpec): Promise<Sandbox>;
}

// docker.ts
function checkDocker(dockerBin?: string): Promise<boolean>;
class DockerSandboxProvider implements SandboxProvider {
  constructor(opts?: { image?: string; dockerBin?: string }); // image defaults to "alpine:3.20"
  readonly id: "docker";
  provision(spec: SandboxSpec): Promise<Sandbox>;
}

// registry.ts
class SandboxProviders {
  register(provider: SandboxProvider): this;
  get(id: string): SandboxProvider; // throws on unknown id
  list(): string[];
}
function createDefaultSandboxRegistry(): SandboxProviders; // pre-registers local + docker
```

## Usage

```ts
import { createDefaultSandboxRegistry } from "@nyx/sandbox";

const sandboxes = createDefaultSandboxRegistry();
const provider = sandboxes.get(process.env.NYX_ENV === "production" ? "docker" : "local");

const sb = await provider.provision({
  provider: provider.id,
  workdir: "/tmp/nyx-agent-run-42", // docker: host side of the /workspace bind
  network: "none",
  limits: { memory_mb: 512, cpu: 1.5 },
});

const res = await sb.exec("grep -r secret . || true", { timeout_ms: 5000 });
await sb.writeFile("notes.txt", "hello");
const entries = await sb.list(".");
await sb.destroy();
```

## Design notes / invariants

- **Path containment is centralized.** `resolveContained` is a pure
  `path.resolve`-based check (empty target → workdir; `..` that stays inside
  is allowed; `../../etc/passwd`, absolute paths outside, and sibling-prefix
  paths like `/workdirx` are refused with `PathEscapeError`).
  `assertRealpathContained` additionally resolves symlinks on both the
  workdir and the target — a symlink planted inside the workdir that points
  outside (including _dangling_ symlinks whose target does not exist yet)
  is caught before any fs operation. Providers run every `readFile`,
  `writeFile`, and `list` path through it and operate on the returned real
  path. Known Phase 0 limitation: the check-then-use gap is still a TOCTOU
  window on the local provider.
- **Local provider is development only — no network isolation.** Commands
  run directly on your host via `/bin/bash -c` inside a fresh `mkdtemp`
  dir under the provider root. The child gets a minimal env allowlist
  (`PATH`, `HOME=<workdir>`, `LANG`) — `process.env` is never inherited
  wholesale — plus whatever `spec.env` / `exec`-time env the caller passes.
  There are no CPU/memory limits and no network blocking. When
  `NYX_ENV=production` (or the `force_prod` test flag) `provision()` throws
  `code: "not_implemented"` — "local sandbox is not allowed in production;
  use the docker provider".
- **Local wall-clock timeout** kills the child's whole process group with
  SIGKILL and reports `exit_code: 137` (128+9). **Docker wall-clock
  timeout** kills the `docker exec` CLI and reports `exit_code: 124`
  (mirroring `timeout(1)`) with a `wall clock timeout` note on stderr; the
  process inside the container is reaped when the container is removed.
- **Output capture is capped at 1 MB per stream** (`stdout`/`stderr`), with
  `truncated: true` when the cap was hit; streams are still drained so a
  chatty command cannot deadlock on a full pipe.
- **Docker provider talks to the `docker` CLI only** (no dockerode). The
  sandbox id _is_ the container name (`nyx-sbx-<nanoid>`). The host bind
  source is `spec.workdir` (created if missing; removed again on `destroy()`
  only when the provider created it). `spec.limits.memory_mb` / `.cpu` map
  to `--memory`/`--cpus`; `limits.wall_ms` is per-exec (it defaults the
  `exec` timeout, it is not a container-level limit). `destroy()` runs
  `docker rm -f` and is idempotent ("No such container" is treated as
  success).
- **Docker file APIs validate paths lexically** via
  `resolveContained("/workspace", path)`; symlinks inside the container are
  not re-resolved there (the bind mount is the containment boundary).
- The registry is the only way the kernel/tools runtime should obtain a
  provider; concrete providers are never imported directly.

## Exact commands run on your machine (audit list)

The docker provider shells out to exactly these shapes (`dockerBin`
defaults to `docker`; the sandbox id below is the full container name
`nyx-sbx-<nanoid>`):

| Operation    | Command                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| availability | `docker version` (must exit 0 within 3 s)                                                                                                                                   |
| provision    | `docker run -d --name <id> --network none -v <spec.workdir>:/workspace -w /workspace [--memory <n>m] [--cpus <n>] <image> sleep infinity` (image defaults to `alpine:3.20`) |
| exec         | `docker exec [-w <contained cwd>] [-e K=V ...] <id> sh -c <cmd>`                                                                                                            |
| readFile     | `docker exec <id> sh -c 'base64 <path>'` (output decoded, whitespace stripped)                                                                                              |
| writeFile    | `docker exec -i <id> sh -c 'base64 -d > <path>'` (payload base64-fed via stdin)                                                                                             |
| list         | `docker exec <id> sh -c 'for f in <path>/*; do [ -e "$f" ]                                                                                                                  |     | continue; if [ -d "$f" ]; then echo "d 0 $(basename "$f")"; else echo "f $(wc -c < "$f") $(basename "$f")"; fi; done'` |
| destroy      | `docker rm -f <id>`                                                                                                                                                         |

The local provider runs `/bin/bash -c <cmd>` with `cwd` inside the sandbox
workdir and the minimal env allowlist, and uses plain `fs`
(`readFile`/`writeFile`/`readdir`/`stat`/`rm -rf` scoped under the provider
root) for its file APIs.

## What is intentionally deferred

- **Network**: Phase 0 is `--network none` only. `spec.network` of
  `allowlist` or `open` makes `provision()` throw `not_implemented`,
  pointing at the roadmap egress-proxy work (an allowlisted HTTP(S) proxy
  inspected per request).
- Docker list output is a line protocol: file names containing newlines do
  not round-trip (such entries are skipped); names with spaces do.
- No seccomp/syscall profiles, no per-sandbox user namespacing, no
  snapshot/restore, no `docker compose`-style multi-container sandboxes.
- TOCTOU hardening of local file APIs (openat2-style `RESOLVE_IN_*` flags)
  is future work; today containment is checked immediately before each fs
  call.

## Tests

`pnpm --filter @nyx/sandbox test` — the local/paths/registry suites always
run. The docker suite runs `checkDocker()` first and **skips when the
daemon is missing or `NYX_SKIP_DOCKER` is set**. The first docker test pays
the `alpine:3.20` image pull latency on a fresh machine.
