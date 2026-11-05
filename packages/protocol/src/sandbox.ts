// SPDX-License-Identifier: AGPL-3.0-or-later
// Sandbox contracts. Tool execution happens inside a sandbox; the sandbox has
// no ambient authority. Path containment is enforced centrally in the tool
// runtime (and re-enforced here by providers on their own file APIs).

import type { Engagement } from "./scope.js";

export interface SandboxSpec {
  provider: string;
  workdir: string;
  image?: string;
  network: "none" | "allowlist" | "open";
  allowlist?: string[];
  limits?: { cpu?: number; memory_mb?: number; wall_ms?: number };
  env?: Record<string, string>;
  /**
   * Phase 6.1 — present iff network is "allowlist": the identity the egress
   * proxy binds its listeners for. The engagement snapshot is immutable for
   * the session's life (bound at creation), so this rides along with it.
   */
  egress?: {
    session_id: string;
    engagement: Engagement;
  };
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
  /**
   * Phase 6.1 — present iff this sandbox is egress-proxied ("allowlist"
   * network): the gateway the proxy listens on and the port mapper for the
   * engagement's rate classes. Wrappers that take an explicit proxy flag
   * (sqlmap --proxy, ffuf -x, …) resolve their class port through this so
   * per-class limits are enforced AT THE PROXY listener they target.
   */
  readonly egress?: {
    gateway: string;
    portFor(rateClass: string | null): number;
  };
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
