// SPDX-License-Identifier: AGPL-3.0-or-later
// DockerSandboxProvider — drives the `docker` CLI directly (no dockerode).
//
// Phase 6.1: `network: "allowlist"` sandboxes get a per-sandbox `--internal`
// bridge (no NAT out, ICC off) whose only useful address is the gateway,
// where the kernel-process egress proxy binds per-rate-class CONNECT
// listeners (see egress_proxy/ and docs/EGRESS-PROXY.md). `network: "open"`
// is still refused — there is no configuration that produces an unproxied
// container with egress. Every command this package runs on your machine is
// listed in the README so operators can audit it.

import { spawn } from "node:child_process";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { customAlphabet, nanoid } from "nanoid";
import type { ExecResult, Sandbox, SandboxProvider, SandboxSpec } from "@nyx/protocol";
import { resolveContained } from "./paths.js";
import type { ForkableSandbox } from "./fork.js";
import type { SandboxEgressBinding } from "./egress_proxy/types.js";

/** Absolute mount point of the host bind inside every container. */
const WORKSPACE = "/workspace";
const MAX_CAPTURE_BYTES = 1024 * 1024;
/** docker run gets a long leash: the first run may pull the image. */
const RUN_TIMEOUT_MS = 180_000;

export interface DockerSandboxOptions {
  /** Image used when the SandboxSpec does not name one. Default "alpine:3.20". */
  image?: string;
  /** Docker CLI binary. Default "docker". */
  dockerBin?: string;
  /**
   * Phase 6.1 — the kernel-process egress proxy binding. Required for
   * `network: "allowlist"` provisions (no binder → refused: no proxy, no
   * tools). Wired by the apps from @nyx/security's createEgressBinder.
   */
  egress?: SandboxEgressBinding;
}

/** True when `docker version` exits 0 within 3 seconds. */
export async function checkDocker(dockerBin = "docker"): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(dockerBin, ["version"], { stdio: "ignore" });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 3000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function notImplemented(message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = "not_implemented";
  return err;
}

function providerError(message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = "provider_error";
  return err;
}

/** Quote a path for safe interpolation into a `sh -c` script. */
function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Append `chunk` to `buf`, stopping at `cap` bytes. Flags truncation. */
function appendCapped(
  buf: Buffer,
  chunk: Buffer,
  cap: number,
): { buf: Buffer; truncated: boolean } {
  if (buf.length >= cap) return { buf, truncated: true };
  const room = cap - buf.length;
  if (chunk.length <= room) return { buf: Buffer.concat([buf, chunk]), truncated: false };
  return { buf: Buffer.concat([buf, chunk.subarray(0, room)]), truncated: true };
}

interface CliResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  truncated: boolean;
  timed_out: boolean;
}

/**
 * Run the docker CLI with `args`, capturing output (capped at 1 MB per
 * stream). Optional stdin payload and wall-clock timeout (on fire the CLI
 * process is SIGKILLed and timed_out is reported — the caller decides what
 * that means, e.g. exit_code 124 for exec).
 */
async function cliRun(
  dockerBin: string,
  args: string[],
  opts: { stdin?: string; timeout_ms?: number } = {},
): Promise<CliResult> {
  const started = performance.now();
  const child: ChildProcessWithoutNullStreams = spawn(dockerBin, args);

  let out: Buffer = Buffer.alloc(0);
  let errOut: Buffer = Buffer.alloc(0);
  let truncated = false;
  // Keep consuming past the cap so the CLI never blocks on a full pipe.
  child.stdout.on("data", (chunk: Buffer) => {
    const r = appendCapped(out, chunk, MAX_CAPTURE_BYTES);
    out = r.buf;
    if (r.truncated) truncated = true;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const r = appendCapped(errOut, chunk, MAX_CAPTURE_BYTES);
    errOut = r.buf;
    if (r.truncated) truncated = true;
  });

  if (opts.stdin !== undefined) {
    child.stdin.on("error", () => {
      // EPIPE when the CLI dies before consuming stdin; the close event
      // carries the real failure (non-zero exit + stderr) which we throw.
    });
    child.stdin.end(opts.stdin);
  } else {
    child.stdin.end();
  }

  let timedOut = false;
  let killer: NodeJS.Timeout | undefined;
  const timeoutMs = opts.timeout_ms;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
  }

  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", (err: Error) => reject(err));
      child.once("close", (code) => resolve(code));
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw notImplemented(
        `Docker is required for the docker sandbox provider: failed to launch "${dockerBin}" (is Docker installed and on PATH?)`,
      );
    }
    throw err;
  } finally {
    if (killer !== undefined) clearTimeout(killer);
  }

  return {
    exit_code: exitCode !== null ? exitCode : -1,
    stdout: out.toString("utf8"),
    stderr: errOut.toString("utf8"),
    duration_ms: Math.round(performance.now() - started),
    truncated,
    timed_out: timedOut,
  };
}

function throwIfFailed(op: string, r: CliResult): void {
  if (r.exit_code !== 0) {
    throw providerError(
      `docker ${op} failed (exit ${r.exit_code}): ${r.stderr.trim() || "(no stderr)"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 6.1 — pure arg builders (unit-tested without a daemon; the exact
// vectors the provider passes to the docker CLI, so tests can assert the
// network posture — internal bridge, ICC off, and NO socket/bind mounts
// ever appear in a run vector).
// ---------------------------------------------------------------------------

/** `--internal` = no NAT/masquerade out; ICC off = containers cannot talk to
 *  each other on this bridge; the gateway (host side) stays reachable. */
export function egressNetworkCreateArgs(name: string): string[] {
  return [
    "network",
    "create",
    "--internal",
    "--opt",
    "com.docker.network.bridge.enable_icc=false",
    "--label",
    "org.nyx.egress=true",
    name,
  ];
}

export function egressNetworkGatewayInspectArgs(name: string): string[] {
  return ["network", "inspect", name, "--format", "{{(index .IPAM.Config 0).Gateway}}"];
}

/** Gateway AND subnet in one inspect ({{.}} delimits; "gw|subnet"). */
export function egressNetworkTopologyInspectArgs(name: string): string[] {
  return [
    "network",
    "inspect",
    name,
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}|{{(index .IPAM.Config 0).Subnet}}",
  ];
}

export function egressNetworkConnectedContainersArgs(name: string): string[] {
  return ["network", "inspect", name, "--format", "{{range .Containers}}{{.Name}}\n{{end}}"];
}

export function egressNetworkDisconnectArgs(name: string, container: string): string[] {
  return ["network", "disconnect", "-f", name, container];
}

export function egressNetworkRmArgs(name: string): string[] {
  return ["network", "rm", name];
}

/** The shared `docker run` vector for provision and fork (network varies). */
export function containerRunArgs(opts: {
  container: string;
  network: string;
  hostDir: string;
  image: string;
  limits?: { memory_mb?: number; cpu?: number };
  /**
   * R1-5 (Phase 6.4): null the container's DNS — docker's embedded resolver
   * forwards arbitrary names out of the HOST (an ungated exfil channel).
   * Proxied clients send hostnames in CONNECT/absolute-form requests and
   * never resolve locally; direct resolvers have no route anyway.
   */
  deadDns?: boolean;
}): string[] {
  const args = [
    "run",
    "-d",
    "--name",
    opts.container,
    "--network",
    opts.network,
    "-v",
    `${opts.hostDir}:${WORKSPACE}`,
    "-w",
    WORKSPACE,
  ];
  if (opts.deadDns === true) {
    // 127.0.0.255: loopback, no listener — instant refusal, no query leaves.
    args.push("--dns", "127.0.0.255", "--dns-search", ".");
  }
  if (opts.limits?.memory_mb !== undefined && opts.limits.memory_mb > 0) {
    args.push("--memory", `${opts.limits.memory_mb}m`);
  }
  if (opts.limits?.cpu !== undefined && opts.limits.cpu > 0) {
    args.push("--cpus", String(opts.limits.cpu));
  }
  args.push(opts.image, "sleep", "infinity");
  return args;
}

interface ExecOpts {
  cwd?: string;
  timeout_ms?: number;
  env?: Record<string, string>;
}

/** Phase 6.1 — the egress wiring a sandbox on an "allowlist" network
 *  carries. Parent and forks share one network; whoever's destroy observes
 *  the last endpoint leaving closes the lights (unbind + network rm). */
interface EgressNet {
  /** The docker network name (nyx-egress-<nanoid>). */
  network: string;
  /** The bridge gateway IP the proxy listeners are bound on. */
  gateway: string;
  /** Port mapper for the engagement's rate classes. */
  portFor(rateClass: string | null): number;
  binder: SandboxEgressBinding;
  /** The sandbox id whose listeners these are (the parent). */
  listenerOwnerSandboxId: string;
  /** R1-10: ONLY the listener owner (the parent) unbinds; forks never do
   *  (an early-fork destroy must not kill the parent's live egress). */
  ownsListeners: boolean;
}

/**
 * Docker repository references are lowercase-only — `docker commit` dies
 * with `invalid reference format: repository name … must be lowercase` on
 * any uppercase byte. nanoid's default alphabet is mixed-case, so a fork's
 * temp image draws from this lowercase-only alphabet instead (36^21 ≈ 2^109
 * ids; collision odds stay astronomically low for a tag that lives
 * minutes). Container names (`nyx-sbx-…`) and network names
 * (`nyx-egress-…`) are different contracts — `[a-zA-Z0-9][a-zA-Z0-9_.-]*` —
 * and keep nanoid. (v0.7.4: the mixed-case tag kept the test-docker CI
 * lane red on every run it ever had; docker.test.ts asserts this
 * hermetically.)
 */
const lowerId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 21);

/** The temp image a fork commits the parent to: `nyx-fork-<lowercase-id>`. */
export function forkImageName(): string {
  return `nyx-fork-${lowerId()}`;
}

class DockerSandbox implements ForkableSandbox {
  /** The sandbox id IS the container name: nyx-sbx-<nanoid>. */
  readonly id: string;
  /** Container-internal workdir: the mount point of the host bind. */
  readonly workdir = WORKSPACE;
  private destroyed = false;

  /** Present iff this sandbox is egress-proxied (network "allowlist"). */
  readonly egress?: {
    gateway: string;
    portFor(rateClass: string | null): number;
  };

  constructor(
    id: string,
    private readonly hostDir: string,
    private readonly dockerBin: string,
    private readonly createdHostDir: boolean,
    private readonly baseEnv: Record<string, string>,
    private readonly wallMs: number | undefined,
    private readonly live: Set<string>,
    /** Resource limits mirrored into forked children (§6.2 R4-5). */
    private readonly limits: { memory_mb?: number; cpu?: number } | undefined = undefined,
    /**
     * The temp image a fork committed for THIS container (§6.2 R4-3):
     * destroy() removes it AFTER the container is gone, else every fork
     * leaks a dangling image on the daemon.
     */
    private readonly forkImageId: string | undefined = undefined,
    /** Phase 6.1 — egress wiring when provisioned on an allowlist network. */
    private readonly egressNet: EgressNet | undefined = undefined,
  ) {
    this.id = id;
    if (egressNet !== undefined) {
      this.egress = { gateway: egressNet.gateway, portFor: egressNet.portFor };
    }
  }

  /**
   * Phase 4 §4: fork-per-child, the docker shape. `docker commit` the
   * parent container to a TEMP IMAGE (captures everything in the
   * container's own layers — installed packages, /tmp state, env baked at
   * run), run the child from that image with a FRESH host bind (bind mounts
   * are not part of a commit, so the workspace rides along with a plain
   * host-side `cp -a`), then remove the temp image (the running child keeps
   * its layers; the tag does not linger). No shared mounts or handles with
   * the parent after this returns — isolation is the point.
   */
  async fork(): Promise<Sandbox> {
    const tempImage = forkImageName();
    const childName = `nyx-sbx-${nanoid()}`;
    const childHostDir = path.join(path.dirname(this.hostDir), childName);

    const commit = await cliRun(this.dockerBin, ["commit", this.id, tempImage], {
      timeout_ms: RUN_TIMEOUT_MS,
    });
    throwIfFailed("commit (fork)", commit);
    // The image id (not the tag): destroy() removes it after the container,
    // so a fork's committed layers never linger as a dangling image (§6.2
    // R4-3 — rmi-ing the TAG while the child runs only untags it).
    const forkImageId = commit.stdout.trim();

    try {
      await fsp.mkdir(childHostDir, { recursive: true });
      // Workspace copy BEFORE the container starts (§6.2 R4-10): the host
      // bind is independent of the container, so populating it first leaves
      // NO window in which the child runs against an empty /workspace.
      // Permissions and symlinks preserved via cp -a.
      const cpExit = await new Promise<number | null>((resolveP, rejectP) => {
        const cp = spawn(
          "cp",
          ["-a", `${this.hostDir}${path.sep}.`, `${childHostDir}${path.sep}`],
          { stdio: ["ignore", "ignore", "ignore"] },
        );
        cp.once("error", (e: Error) => rejectP(e));
        cp.once("close", (code) => resolveP(code));
      });
      if (cpExit !== 0) {
        throw Object.assign(
          new Error(
            `cp -a ${this.hostDir}/. ${childHostDir}/ exited ${String(cpExit)} (fork of ${this.id})`,
          ),
          { code: "provider_error" },
        );
      }
      const args = containerRunArgs({
        container: childName,
        // Phase 6.1: a fork of an egress-proxied sandbox re-attaches the
        // PARENT's network (same session, same engagement, same proxy
        // listeners) — never `none`, which would silently strip the child's
        // scoped egress; never anything unproxied.
        network: this.egressNet?.network ?? "none",
        hostDir: childHostDir,
        image: tempImage,
        limits: this.limits,
      });
      const run = await cliRun(this.dockerBin, args, { timeout_ms: RUN_TIMEOUT_MS });
      throwIfFailed("run (fork)", run);
    } catch (err) {
      // Best-effort unwind, ordered: container first, then the temp image
      // (an rmi that beats the rm only untags while the container lives).
      try {
        await cliRun(this.dockerBin, ["rm", "-f", childName]);
      } catch {
        /* the container may never have been created */
      }
      try {
        await cliRun(this.dockerBin, ["rmi", "-f", tempImage]);
      } catch {
        /* best-effort */
      }
      throw err;
    }

    this.live.add(childName);
    return new DockerSandbox(
      childName,
      childHostDir,
      this.dockerBin,
      true, // fork created the host bind dir; destroy() removes it again
      this.baseEnv,
      this.wallMs,
      this.live,
      this.limits,
      forkImageId,
      // The child shares the parent's egress network and its listeners, but
      // NEVER unbinds them (R1-10: only the owner does); it best-effort
      // removes the network when it is the last endpoint out.
      this.egressNet !== undefined ? { ...this.egressNet, ownsListeners: false } : undefined,
    );
  }

  async exec(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const cwd = resolveContained(WORKSPACE, opts.cwd ?? ".");
    const args = ["exec"];
    if (cwd !== WORKSPACE) args.push("-w", cwd);
    const env = { ...this.baseEnv, ...opts.env };
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    args.push(this.id, "sh", "-c", cmd);

    const r = await cliRun(this.dockerBin, args, {
      timeout_ms: opts.timeout_ms ?? this.wallMs,
    });
    if (r.timed_out) {
      // 124 mirrors timeout(1): the node-side wall clock fired and we
      // SIGKILLed the docker-exec CLI. The process inside the container may
      // still be running until destroy() removes the container.
      const stderr =
        (r.stderr.length > 0 && !r.stderr.endsWith("\n") ? `${r.stderr}\n` : r.stderr) +
        `nyx-sandbox: wall clock timeout (${opts.timeout_ms ?? this.wallMs}ms) exceeded`;
      return {
        exit_code: 124,
        stdout: r.stdout,
        stderr,
        duration_ms: r.duration_ms,
        truncated: r.truncated,
      };
    }
    return {
      exit_code: r.exit_code,
      stdout: r.stdout,
      stderr: r.stderr,
      duration_ms: r.duration_ms,
      truncated: r.truncated,
    };
  }

  async readFile(p: string): Promise<Buffer> {
    // Containment note (§6.2 R5-7): unlike the local provider's
    // assertRealpathContained, this is a STRING check — a symlink inside
    // /workspace can redirect within the CONTAINER. The container itself is
    // the security boundary for the docker provider (exec reaches those
    // paths anyway); the string check guards the CLI-injection surface.
    const target = resolveContained(WORKSPACE, p);
    const r = await cliRun(this.dockerBin, [
      "exec",
      this.id,
      "sh",
      "-c",
      `base64 ${shQuote(target)}`,
    ]);
    throwIfFailed("exec (readFile)", r);
    // §6.2 R5-2: a truncated capture means the base64 was cut mid-stream —
    // decoding it would silently corrupt the bytes (and every hash over
    // them). Loud, never partial.
    if (r.truncated) {
      const err = new Error(
        `readFile(${p}): output exceeded the ${MAX_CAPTURE_BYTES}-byte capture cap; ` +
          `refusing to return truncated bytes`,
      ) as Error & { code: string };
      err.code = "provider_error";
      throw err;
    }
    // busybox base64 wraps output at 76 columns — strip all whitespace.
    return Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
  }

  async writeFile(p: string, data: Buffer | string): Promise<void> {
    const target = resolveContained(WORKSPACE, p);
    const b64 = Buffer.from(data).toString("base64");
    const r = await cliRun(
      this.dockerBin,
      ["exec", "-i", this.id, "sh", "-c", `base64 -d > ${shQuote(target)}`],
      { stdin: b64 },
    );
    throwIfFailed("exec (writeFile)", r);
  }

  async list(p: string): Promise<Array<{ name: string; type: "file" | "dir"; size: number }>> {
    const target = resolveContained(WORKSPACE, p);
    const script =
      `for f in ${shQuote(target)}/*; do [ -e "$f" ] || continue; ` +
      `if [ -d "$f" ]; then echo "d 0 $(basename "$f")"; ` +
      `else echo "f $(wc -c < "$f") $(basename "$f")"; fi; done`;
    const r = await cliRun(this.dockerBin, ["exec", this.id, "sh", "-c", script]);
    throwIfFailed("exec (list)", r);
    const entries: Array<{ name: string; type: "file" | "dir"; size: number }> = [];
    for (const line of r.stdout.split("\n")) {
      if (line === "") continue;
      const m = /^([df]) (\d+) (.*)$/.exec(line);
      // Names containing newlines cannot round-trip this line format in
      // Phase 0; those lines are skipped (documented in the README).
      if (m === null) continue;
      const [type, size, name] = [m[1], m[2], m[3]];
      if (type === undefined || size === undefined || name === undefined) continue;
      entries.push({ name, type: type === "d" ? "dir" : "file", size: Number(size) });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries;
  }

  async destroy(): Promise<void> {
    // R1-9: retriable — the destroyed flag is set only on SUCCESS, so a
    // failed rm (daemon hiccup) leaves the destroy callable again instead
    // of stranding a live container with bound listeners forever.
    if (this.destroyed) return;
    if (this.egressNet !== undefined && this.egressNet.ownsListeners) {
      // R1-9/R1-10: the LISTENER OWNER unbinds FIRST — no new egress can be
      // authorized from this moment — before the container goes away, so a
      // failed rm can never leave live listeners behind. (The parent session
      // is being torn down; its forks are aborted with it.)
      await this.egressNet.binder.unbindNetwork(this.egressNet.listenerOwnerSandboxId);
    }
    try {
      const r = await cliRun(this.dockerBin, ["rm", "-f", this.id]);
      // "No such container" means someone removed it first — destroy stays
      // idempotent. Anything else is a real failure worth surfacing.
      if (r.exit_code !== 0 && !/no such container/i.test(r.stderr)) {
        throwIfFailed("rm", r);
      }
    } finally {
      this.live.delete(this.id);
    }
    if (this.egressNet !== undefined) {
      // The network itself: removed when the last endpoint leaves. The
      // parent (owner) already unbound; forks only ever best-effort rm.
      await this.maybeTeardownEgress();
    }
    this.destroyed = true;
    if (this.createdHostDir) {
      // We created the host bind dir during provision — remove it again.
      await fsp.rm(this.hostDir, { recursive: true, force: true });
    }
    if (this.forkImageId !== undefined) {
      // AFTER the container is gone: remove the committed fork image by id,
      // else every fork leaks a dangling multi-layer snapshot of the parent
      // on the daemon (§6.2 R4-3). Best-effort — a missing image is fine.
      try {
        await cliRun(this.dockerBin, ["rmi", this.forkImageId]);
      } catch {
        /* already gone / daemon refused — clutter, not a correctness issue */
      }
    }
  }

  /**
   * Inspect the egress network's remaining endpoints; unbind + rm when none
   * are left. Best-effort by design: an inspect/rm failure leaves the network
   * INERT (no listener survives the kernel process anyway — a leaked bridge
   * without listeners passes no egress) and `docker network prune --filter
   * label=org.nyx.egress=true` reclaims it.
   */
  private async maybeTeardownEgress(): Promise<void> {
    const egress = this.egressNet;
    if (egress === undefined) return;
    try {
      const r = await cliRun(this.dockerBin, egressNetworkConnectedContainersArgs(egress.network), {
        timeout_ms: 30_000,
      });
      if (r.exit_code !== 0) return; // already removed, or daemon hiccup
      const remaining = r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (remaining.length > 0) return; // forks still attached — same session
      // Last endpoint out: the bridge itself goes (the LISTENERS were
      // already unbound by the owner's destroy — R1-9/R1-10).
      await cliRun(this.dockerBin, egressNetworkRmArgs(egress.network), {
        timeout_ms: 30_000,
      });
    } catch {
      /* best-effort: an inert labeled network is reclaimed via prune */
    }
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly id = "docker";

  private readonly image: string;
  private readonly dockerBin: string;
  private readonly egress: SandboxEgressBinding | undefined;
  /** Container names this provider created and has not destroyed yet. */
  private readonly live = new Set<string>();

  constructor(opts: DockerSandboxOptions = {}) {
    this.image = opts.image ?? "alpine:3.20";
    this.dockerBin = opts.dockerBin ?? "docker";
    this.egress = opts.egress;
  }

  async provision(spec: SandboxSpec): Promise<Sandbox> {
    if (spec.network === "open") {
      throw notImplemented(
        'network mode "open" is not supported and never will be — egress is ' +
          "allowlist-only via the egress proxy (docs/EGRESS-PROXY.md)",
      );
    }
    if (spec.network === "allowlist" && this.egress === undefined) {
      throw notImplemented(
        'network mode "allowlist" requires the egress proxy binder — no proxy, no tools ' +
          "(docs/EGRESS-PROXY.md)",
      );
    }
    if (spec.network === "allowlist" && spec.egress === undefined) {
      throw notImplemented(
        'network mode "allowlist" requires spec.egress (the session/engagement identity ' +
          "the proxy binds its listeners for)",
      );
    }
    if (!(await checkDocker(this.dockerBin))) {
      throw notImplemented(
        `Docker is required for the docker sandbox provider (checkDocker failed for "${this.dockerBin}")`,
      );
    }

    // The host side of the bind mount: spec.workdir, created if missing.
    // Only removed again by destroy() when we created it here.
    const hostDir = path.resolve(spec.workdir);
    let existed = true;
    try {
      await fsp.stat(hostDir);
    } catch {
      existed = false;
    }
    await fsp.mkdir(hostDir, { recursive: true });

    const container = `nyx-sbx-${nanoid()}`;
    const image = spec.image ?? this.image;

    // ── Phase 6.1: the allowlist path. Create the internal bridge, learn
    // its gateway, bind the proxy listeners there (a bind failure ABORTS the
    // provision — no proxy, no tools), and run the container attached to it
    // with the proxy env baked into every exec. ──
    let egressNet: EgressNet | undefined;
    let env = spec.env ?? {};
    if (spec.network === "allowlist" && this.egress !== undefined && spec.egress !== undefined) {
      const network = `nyx-egress-${nanoid()}`;
      const created = await cliRun(this.dockerBin, egressNetworkCreateArgs(network), {
        timeout_ms: 30_000,
      });
      throwIfFailed("network create", created);
      try {
        const topo = await cliRun(this.dockerBin, egressNetworkTopologyInspectArgs(network), {
          timeout_ms: 30_000,
        });
        throwIfFailed("network inspect (topology)", topo);
        const [gatewayRaw, subnetRaw] = topo.stdout.trim().split("|");
        const gateway = (gatewayRaw ?? "").trim();
        const subnet = (subnetRaw ?? "").trim();
        // R1-17: the wildcard/unspecified address would bind listeners on
        // EVERY host interface — reject it.
        if (net.isIP(gateway) === 0 || gateway === "0.0.0.0" || gateway === "::") {
          throw providerError(
            `egress network ${network} has no usable gateway (inspect returned "${gateway.slice(0, 60)}")`,
          );
        }
        if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(subnet)) {
          throw providerError(
            `egress network ${network} has no usable subnet (inspect returned "${subnet.slice(0, 60)}")`,
          );
        }
        // The bind throws on port collision → abort before the container
        // exists; the sandbox is never spawned without its proxy.
        const info = await this.egress.bindNetwork(network, gateway, {
          session_id: spec.egress.session_id,
          sandbox_id: container,
          engagement: spec.egress.engagement,
          subnet,
        });
        egressNet = {
          network,
          gateway,
          portFor: info.proxyPortFor,
          binder: this.egress,
          listenerOwnerSandboxId: container,
          ownsListeners: true,
        };
        env = { ...env, ...info.env };
      } catch (err) {
        // Wind the network back — no sandbox exists, nothing may linger.
        try {
          await cliRun(this.dockerBin, egressNetworkRmArgs(network), { timeout_ms: 30_000 });
        } catch {
          /* best-effort: labeled network, reclaimed via prune */
        }
        throw err;
      }
    }

    const args = containerRunArgs({
      container,
      network: egressNet?.network ?? "none",
      hostDir,
      image,
      limits: spec.limits,
      ...(egressNet !== undefined ? { deadDns: true } : {}),
    });

    const r = await cliRun(this.dockerBin, args, { timeout_ms: RUN_TIMEOUT_MS });
    if (r.timed_out) {
      // Best-effort cleanup: the run may or may not have created the
      // container, and the egress wiring must not outlive the failure.
      void cliRun(this.dockerBin, ["rm", "-f", container]).catch(() => undefined);
      if (egressNet !== undefined) {
        void egressNet.binder.unbindNetwork(egressNet.listenerOwnerSandboxId);
        void cliRun(this.dockerBin, egressNetworkRmArgs(egressNet.network)).catch(() => undefined);
      }
      throw providerError(
        `docker run timed out after ${RUN_TIMEOUT_MS}ms (first run may be pulling ${image})`,
      );
    }
    if (r.exit_code !== 0) {
      if (egressNet !== undefined) {
        await egressNet.binder.unbindNetwork(egressNet.listenerOwnerSandboxId);
        await cliRun(this.dockerBin, egressNetworkRmArgs(egressNet.network)).catch(() => undefined);
      }
      throwIfFailed("run", r);
    }
    this.live.add(container);
    return new DockerSandbox(
      container,
      hostDir,
      this.dockerBin,
      !existed,
      env,
      spec.limits?.wall_ms,
      this.live,
      { memory_mb: spec.limits?.memory_mb, cpu: spec.limits?.cpu },
      undefined,
      egressNet,
    );
  }
}
