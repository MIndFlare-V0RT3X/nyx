// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §3 — the security tool executor.
//
// The binaries run OUTSIDE the network-locked sandbox (the Phase 0 sandbox is
// --network none by design; container-level egress ACLs are the documented
// roadmap). The tool layer IS the network mediation: every target is
// validated (scope engine + pinned resolution + checkResolvedTarget) and
// rate-limited BEFORE the binary fires, and the argv is composed ONLY from
// handler-validated values — the model never touches raw arguments.
//
// Both executor modes validate every interpolated token against a strict
// printable single-line charset (the Phase 4 §6.2 R5-8 lesson): no shell
// metacharacters, no whitespace, no control characters ever reach a command
// line. The host executor spawns WITHOUT a shell; the sandbox executor
// composes a bash -c string (the sandbox's exec transport) and therefore
// refuses anything outside the safe charset outright.

import { spawn } from "node:child_process";

/**
 * The strict argv-token charset: printable ASCII minus shell-active
 * metacharacters. URL syntax is admitted (?, &, # for query strings and
 * fragments) — the sandbox executor quotes every token, so these cannot
 * split words or start comments.
 */
const SAFE_TOKEN = /^[A-Za-z0-9._\-/:+=@,%~[\]?&#]+$/;

export interface ExecutorResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface SecurityExecutor {
  run(binary: string, args: string[], opts?: { timeout_ms?: number }): Promise<ExecutorResult>;
}

export class SecurityToolError extends Error {
  constructor(
    readonly code: "skill.error" | "charset" | "binary_failed",
    message: string,
  ) {
    super(message);
    this.name = "SecurityToolError";
  }
}

/** Refuse any token outside the safe charset — before composition, always. */
export function assertSafeTokens(tokens: readonly string[]): void {
  for (const t of tokens) {
    if (!SAFE_TOKEN.test(t)) {
      throw new SecurityToolError(
        "charset",
        `argument token ${JSON.stringify(t)} contains characters outside the ` +
          "printable safe set — refused before any command was composed",
      );
    }
  }
}

/** Runs the binary on the host (operator-installed tools), no shell. */
export class HostSecurityExecutor implements SecurityExecutor {
  async run(
    binary: string,
    args: string[],
    opts: { timeout_ms?: number } = {},
  ): Promise<ExecutorResult> {
    assertSafeTokens([binary, ...args]);
    const timeout = opts.timeout_ms ?? 600_000;
    return await new Promise((resolve) => {
      const child = spawn(binary, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
        if (stdout.length > 64 * 1024 * 1024) child.kill("SIGKILL");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
        if (stderr.length > 4 * 1024 * 1024) child.kill("SIGKILL");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          exit_code: -1,
          stdout,
          stderr: `${stderr}${err.message}`,
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exit_code: code ?? -1, stdout, stderr });
      });
    });
  }
}

/**
 * Runs the binary inside the session sandbox via `ctx.sandbox.exec` (bash -c).
 * Because that transport composes a shell string, the strict charset guard is
 * the difference between an argument and an injection — it runs first.
 */
export class SandboxSecurityExecutor implements SecurityExecutor {
  constructor(
    private readonly sandbox: {
      exec: (
        cmd: string,
        opts?: { timeout_ms?: number },
      ) => Promise<{ exit_code: number; stdout: string; stderr: string }>;
    },
  ) {}

  async run(
    binary: string,
    args: string[],
    opts: { timeout_ms?: number } = {},
  ): Promise<ExecutorResult> {
    assertSafeTokens([binary, ...args]);
    // Every token single-quoted: no globbing, no word splitting, no comment
    // starts — the charset already excludes single quotes, so the quoting
    // itself cannot be escaped (R1-6).
    const cmd = [binary, ...args].map((t) => `'${t}'`).join(" ");
    const r = await this.sandbox.exec(cmd, opts);
    return { exit_code: r.exit_code, stdout: r.stdout, stderr: r.stderr };
  }
}

/** A recording fake for tests — the argv is the assertion surface. */
export class FakeSecurityExecutor implements SecurityExecutor {
  readonly calls: Array<{ binary: string; args: string[] }> = [];
  #response: (call: { binary: string; args: string[] }) => ExecutorResult = () => ({
    exit_code: 0,
    stdout: "",
    stderr: "",
  });

  respondWith(fn: (call: { binary: string; args: string[] }) => ExecutorResult): void {
    this.#response = fn;
  }

  async run(
    binary: string,
    args: string[],
    _opts: { timeout_ms?: number } = {},
  ): Promise<ExecutorResult> {
    const call = { binary, args };
    this.calls.push(call);
    return this.#response(call);
  }
}
