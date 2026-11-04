// SPDX-License-Identifier: AGPL-3.0-or-later
// LocalSandboxProvider — DEVELOPMENT ONLY, NO NETWORK ISOLATION.
//
// Runs commands directly on the host via /bin/bash inside a fresh temp
// directory. It provides filesystem containment (paths + symlinks) and a
// minimal environment allowlist, but nothing else: no network blocking, no
// CPU/memory limits, no syscall filtering. Never use it for untrusted input;
// in production it refuses to provision (NYX_ENV=production) and callers
// must use the docker provider instead.

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { nanoid } from "nanoid";
import type { ExecResult, Sandbox, SandboxProvider, SandboxSpec } from "@nyx/protocol";
import { assertRealpathContained, resolveContained } from "./paths.js";
import type { ForkableSandbox } from "./fork.js";

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const MAX_CAPTURE_BYTES = 1024 * 1024;

export interface LocalSandboxOptions {
  /** Root directory under which sandbox workdirs are created. */
  root?: string;
  /** Test hook: simulate NYX_ENV=production without touching the environment. */
  force_prod?: boolean;
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

function notImplemented(message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = "not_implemented";
  return err;
}

interface ExecOpts {
  cwd?: string;
  timeout_ms?: number;
  env?: Record<string, string>;
}

class LocalSandbox implements ForkableSandbox {
  readonly workdir: string;

  constructor(
    readonly id: string,
    workdir: string,
    private readonly root: string,
    private readonly baseEnv: Record<string, string>,
    private readonly wallMs: number | undefined,
  ) {
    this.workdir = workdir;
  }

  /**
   * Phase 4 §4: fork-per-child. `cp -a` the whole workdir to a fresh
   * sibling under the same provider root — permissions, symlinks and
   * mtimes preserved — then never touch the parent again: no shared
   * mounts, no live handles. The copy includes artifacts/; the caller
   * (subagents manager) resets it via ensureArtifactsDir.
   */
  async fork(): Promise<Sandbox> {
    const childDir = join(this.root, `nyx-sbx-${nanoid()}`);
    const exitCode = await new Promise<number | null>((resolveP, rejectP) => {
      const cp = spawn("cp", ["-a", this.workdir, childDir], { stdio: ["ignore", "ignore", "ignore"] });
      cp.once("error", (err: Error) => rejectP(err));
      cp.once("close", (code) => resolveP(code));
    });
    if (exitCode !== 0) {
      const err = new Error(
        `cp -a ${this.workdir} ${childDir} exited ${String(exitCode)}`,
      ) as Error & { code: string };
      err.code = "provider_error";
      throw err;
    }
    return new LocalSandbox(basename(childDir), childDir, this.root, this.baseEnv, this.wallMs);
  }

  async exec(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const cwd = opts.cwd !== undefined ? resolveContained(this.workdir, opts.cwd) : this.workdir;
    // Minimal allowlist — never inherit process.env wholesale. HOME is the
    // sandbox workdir so tools that write "somewhere" stay contained.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? DEFAULT_PATH,
      HOME: this.workdir,
      LANG: process.env.LANG ?? "C.UTF-8",
    };
    for (const [k, v] of Object.entries(this.baseEnv)) env[k] = v;
    for (const [k, v] of Object.entries(opts.env ?? {})) env[k] = v;

    const started = performance.now();
    // detached: own process group, so a wall-clock kill takes down the whole
    // command tree (bash -c "sleep 5" spawns children of its own).
    const child = spawn("/bin/bash", ["-c", cmd], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let out: Buffer = Buffer.alloc(0);
    let errOut: Buffer = Buffer.alloc(0);
    let truncated = false;
    // Keep consuming past the cap so the child never blocks on a full pipe.
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

    const timeoutMs = opts.timeout_ms ?? this.wallMs;
    let killer: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      killer = setTimeout(() => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL"); // whole process group
          } catch {
            // group already gone
          }
        }
        child.kill("SIGKILL");
      }, timeoutMs);
    }

    let exitCode: number | null;
    let exitSignal: NodeJS.Signals | null;
    try {
      [exitCode, exitSignal] = await new Promise<[number | null, NodeJS.Signals | null]>(
        (resolve, reject) => {
          child.once("error", (err: Error) => reject(err));
          child.once("close", (code, signal) => resolve([code, signal]));
        },
      );
    } finally {
      if (killer !== undefined) clearTimeout(killer);
    }

    // null exit code means death by signal: our wall-clock SIGKILL is
    // reported as 137 (128+9); anything unclassifiable as -1.
    const exit_code = exitCode !== null ? exitCode : exitSignal === "SIGKILL" ? 137 : -1;
    return {
      exit_code,
      stdout: out.toString("utf8"),
      stderr: errOut.toString("utf8"),
      duration_ms: Math.round(performance.now() - started),
      truncated,
    };
  }

  async readFile(p: string): Promise<Buffer> {
    const real = await assertRealpathContained(this.workdir, p);
    return fsp.readFile(real);
  }

  async writeFile(p: string, data: Buffer | string): Promise<void> {
    const real = await assertRealpathContained(this.workdir, p);
    // Parent directories are part of the sandbox's writable surface; a write
    // to "notes/out.txt" creates "notes/" inside the workdir, never outside.
    await fsp.mkdir(dirname(real), { recursive: true });
    return fsp.writeFile(real, data);
  }

  async list(p: string): Promise<Array<{ name: string; type: "file" | "dir"; size: number }>> {
    const real = await assertRealpathContained(this.workdir, p);
    const names = (await fsp.readdir(real)).sort();
    const entries: Array<{ name: string; type: "file" | "dir"; size: number }> = [];
    for (const name of names) {
      try {
        // stat follows symlinks, matching the docker provider's [ -d ] test.
        const st = await fsp.stat(join(real, name));
        if (st.isDirectory()) entries.push({ name, type: "dir", size: 0 });
        else entries.push({ name, type: "file", size: st.size });
      } catch (err) {
        // Broken symlink: invisible, same as the docker provider's [ -e ].
        if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
        throw err;
      }
    }
    return entries;
  }

  async destroy(): Promise<void> {
    // Guard: only ever delete inside the provider root.
    const target = resolveContained(this.root, this.workdir);
    await fsp.rm(target, { recursive: true, force: true });
  }
}

export class LocalSandboxProvider implements SandboxProvider {
  readonly id = "local";

  private readonly root: string;
  private readonly forceProd: boolean;

  constructor(opts: LocalSandboxOptions = {}) {
    this.root = resolve(opts.root ?? join(os.homedir(), ".nyx", "sandboxes"));
    this.forceProd = opts.force_prod === true;
  }

  async provision(spec: SandboxSpec): Promise<Sandbox> {
    if (this.forceProd || process.env.NYX_ENV === "production") {
      throw notImplemented("local sandbox is not allowed in production; use the docker provider");
    }
    await fsp.mkdir(this.root, { recursive: true });
    const workdir = await fsp.mkdtemp(join(this.root, "nyx-sbx-"));
    return new LocalSandbox(
      basename(workdir),
      workdir,
      this.root,
      spec.env ?? {},
      spec.limits?.wall_ms,
    );
  }
}
