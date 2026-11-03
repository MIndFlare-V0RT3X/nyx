// SPDX-License-Identifier: AGPL-3.0-or-later
// Sandbox contracts. Tool execution happens inside a sandbox; the sandbox has
// no ambient authority. Path containment is enforced centrally in the tool
// runtime (and re-enforced here by providers on their own file APIs).

export interface SandboxSpec {
  provider: string;
  workdir: string;
  image?: string;
  network: "none" | "allowlist" | "open";
  allowlist?: string[];
  limits?: { cpu?: number; memory_mb?: number; wall_ms?: number };
  env?: Record<string, string>;
}

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  truncated: boolean;
}

export interface Sandbox {
  readonly id: string;
  readonly workdir: string;
  exec(
    cmd: string,
    opts?: { cwd?: string; timeout_ms?: number; env?: Record<string, string> },
  ): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
  list(path: string): Promise<Array<{ name: string; type: "file" | "dir"; size: number }>>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  readonly id: string;
  provision(spec: SandboxSpec): Promise<Sandbox>;
}
