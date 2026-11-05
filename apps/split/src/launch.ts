// SPDX-License-Identifier: AGPL-3.0-or-later
// The split launcher: spawns the three binaries with SCRUBBED environments
// (the allowlist in @nyx/ipc — PATH/locale basics and the split markers;
// credential env vars never reach the agent or tools processes), waits for
// each to report healthy, and tears everything down cleanly.
//
// Used by the split e2e suite and available to operators as the reference
// orchestration (a `nyx split` command wraps this in Phase 8).

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { scrubEnvironment } from "@nyx/ipc";

export interface LaunchSplitOptions {
  /** Repo root (dist binaries resolve under apps/split/dist). */
  repoRoot: string;
  configPath: string;
  dataDir: string;
  /** The env the KERNEL process inherits (default process.env) — the only
   *  process that sees credential env vars. */
  kernelEnv?: NodeJS.ProcessEnv;
  /** Extra env for the agent/tools processes (already scrubbed; merged
   *  AFTER the allowlist, so keep it non-secret). */
  childEnv?: Record<string, string>;
  /** Per-binary startup timeout (default 30s). */
  timeoutMs?: number;
  /** node binary (default process.execPath). */
  nodeBin?: string;
}

export interface SplitStack {
  kernel: ChildProcess;
  tools: ChildProcess;
  /** Resolves when a binary exits unexpectedly (the runaway-agent path). */
  wait(): Promise<{ which: "kernel" | "tools"; code: number | null }>;
  stop(): Promise<void>;
}

/** Await a child's exit — resolves immediately if it already exited
 *  (`once("exit")` on a dead child would never fire). */
function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

interface BootLine {
  ok: boolean;
  socket?: string;
  token_file?: string;
  pid?: number;
}

async function spawnAndAwaitBoot(
  label: string,
  nodeBin: string,
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ child: ChildProcess; boot: BootLine }> {
  const child = spawn(nodeBin, [script, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = createInterface({ input: child.stdout });
  const stderrChunks: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderrChunks.push(chunk));

  const boot = await new Promise<BootLine>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not report boot within ${timeoutMs}ms\n${stderrChunks.join("")}`));
    }, timeoutMs);
    stdout.once("line", (line: string) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line) as BootLine);
      } catch (err) {
        reject(
          new Error(
            `${label} boot line is not JSON: ${line}\n${stderrChunks.join("")}`,
            { cause: err },
          ),
        );
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited before boot (code ${code})\n${stderrChunks.join("")}`));
    });
  });
  stdout.close();
  return { child, boot };
}

export async function launchSplitStack(opts: LaunchSplitOptions): Promise<SplitStack> {
  const nodeBin = opts.nodeBin ?? process.execPath;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const distDir = `${opts.repoRoot}/apps/split/dist`;

  // The KERNEL process: full env (it reads credential env vars — that is
  // the point; it is the only one).
  const kernelEnv = {
    ...opts.kernelEnv,
    NYX_PROCESS_MODE: "split",
    NYX_DATA_DIR: opts.dataDir,
  };

  // The agent/tools processes: scrubbed allowlist + split markers. They get
  // the RUNTIME dir (sockets + tokens), never the data dir.
  const scrubbed = scrubEnvironment(process.env, {
    keep: ["NYX_ENV", "NYX_LOG_LEVEL"],
    set: {
      NYX_PROCESS_MODE: "split",
      NYX_CONFIG_PATH: opts.configPath,
      NYX_RUNTIME_DIR: `${opts.dataDir}/runtime`,
      ...opts.childEnv,
    },
  });

  const kernel = await spawnAndAwaitBoot(
    "nyx-kernel",
    nodeBin,
    `${distDir}/kernel-main.js`,
    ["--config", opts.configPath, "--data-dir", opts.dataDir],
    kernelEnv,
    timeoutMs,
  );
  try {
    const tools = await spawnAndAwaitBoot(
      "nyx-tools",
      nodeBin,
      `${distDir}/tools-main.js`,
      ["--config", opts.configPath, "--runtime-dir", `${opts.dataDir}/runtime`],
      scrubbed,
      timeoutMs,
    );
    const waitKernel = waitExit(kernel.child).then(() => ({
      which: "kernel" as const,
      code: kernel.child.exitCode,
    }));
    const waitTools = waitExit(tools.child).then(() => ({
      which: "tools" as const,
      code: tools.child.exitCode,
    }));
    return {
      kernel: kernel.child,
      tools: tools.child,
      wait: () => Promise.race([waitKernel, waitTools]),
      stop: async () => {
        // SIGTERM first (graceful: socket close, audit verify, store close);
        // SIGKILL after a short grace so a wedged child can never hang the
        // teardown (the kernel's audit chain is crash-safe — WAL + FULL).
        const children = [tools.child, kernel.child];
        const exited = Promise.all(children.map((child) => waitExit(child)));
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
          }
        }
        const grace = new Promise((r) => setTimeout(r, 4000));
        await Promise.race([exited, grace]);
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }
        await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
      },
    };
  } catch (err) {
    kernel.child.kill("SIGKILL");
    throw err;
  }
}
