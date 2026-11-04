// SPDX-License-Identifier: AGPL-3.0-or-later
// DockerSandboxProvider — drives the `docker` CLI directly (no dockerode).
//
// Phase 0 stance: only `--network none` containers. `allowlist`/`open`
// network modes are refused until the roadmap egress-proxy work lands.
// Every command this package runs on your machine is listed in the README
// so operators can audit it.

import { spawn } from "node:child_process";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { nanoid } from "nanoid";
import type { ExecResult, Sandbox, SandboxProvider, SandboxSpec } from "@nyx/protocol";
import { resolveContained } from "./paths.js";
import type { ForkableSandbox } from "./fork.js";

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

interface ExecOpts {
  cwd?: string;
  timeout_ms?: number;
  env?: Record<string, string>;
}

class DockerSandbox implements ForkableSandbox {
  /** The sandbox id IS the container name: nyx-sbx-<nanoid>. */
  readonly id: string;
  /** Container-internal workdir: the mount point of the host bind. */
  readonly workdir = WORKSPACE;
  private destroyed = false;

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
  ) {
    this.id = id;
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
    const tempImage = `nyx-fork-${nanoid()}`;
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
        const cp = spawn("cp", [
          "-a",
          `${this.hostDir}${path.sep}.`,
          `${childHostDir}${path.sep}`,
        ], { stdio: ["ignore", "ignore", "ignore"] });
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
      const args = [
        "run",
        "-d",
        "--name",
        childName,
        "--network",
        "none",
        "-v",
        `${childHostDir}:${WORKSPACE}`,
        "-w",
        WORKSPACE,
      ];
      // Resource isolation mirrors the parent's limits (§6.2 R4-5) — a
      // forked child must never run with LESS constraint than its parent.
      if (this.limits?.memory_mb !== undefined && this.limits.memory_mb > 0) {
        args.push("--memory", `${this.limits.memory_mb}m`);
      }
      if (this.limits?.cpu !== undefined && this.limits.cpu > 0) {
        args.push("--cpus", String(this.limits.cpu));
      }
      args.push(tempImage, "sleep", "infinity");
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
    if (this.destroyed) return;
    this.destroyed = true;
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
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly id = "docker";

  private readonly image: string;
  private readonly dockerBin: string;
  /** Container names this provider created and has not destroyed yet. */
  private readonly live = new Set<string>();

  constructor(opts: DockerSandboxOptions = {}) {
    this.image = opts.image ?? "alpine:3.20";
    this.dockerBin = opts.dockerBin ?? "docker";
  }

  async provision(spec: SandboxSpec): Promise<Sandbox> {
    if (spec.network !== "none") {
      throw notImplemented(
        `network mode "${spec.network}" is not implemented in Phase 0; only "none" is supported ` +
          "(roadmap: an egress proxy for allowlisted network access)",
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
    const args = [
      "run",
      "-d",
      "--name",
      container,
      "--network",
      "none",
      "-v",
      `${hostDir}:${WORKSPACE}`,
      "-w",
      WORKSPACE,
    ];
    if (spec.limits?.memory_mb !== undefined && spec.limits.memory_mb > 0) {
      args.push("--memory", `${spec.limits.memory_mb}m`);
    }
    if (spec.limits?.cpu !== undefined && spec.limits.cpu > 0) {
      args.push("--cpus", String(spec.limits.cpu));
    }
    args.push(image, "sleep", "infinity");

    const r = await cliRun(this.dockerBin, args, { timeout_ms: RUN_TIMEOUT_MS });
    if (r.timed_out) {
      // Best-effort cleanup: the run may or may not have created the container.
      void cliRun(this.dockerBin, ["rm", "-f", container]).catch(() => undefined);
      throw providerError(
        `docker run timed out after ${RUN_TIMEOUT_MS}ms (first run may be pulling ${image})`,
      );
    }
    throwIfFailed("run", r);
    this.live.add(container);
    return new DockerSandbox(
      container,
      hostDir,
      this.dockerBin,
      !existed,
      spec.env ?? {},
      spec.limits?.wall_ms,
      this.live,
      { memory_mb: spec.limits?.memory_mb, cpu: spec.limits?.cpu },
    );
  }
}
