// SPDX-License-Identifier: AGPL-3.0-or-later
// Environment scrubbing for the split-mode child processes. The kernel is
// the only process that reads credential env vars; the agent and tool
// processes receive an allowlist scrubbed environment so
// `process.env.OPENAI_API_KEY` finds nothing there — structurally, not by
// convention.
//
// The allowlist is deliberately tiny: path/locale basics, the split-mode
// markers, and the token file location (the token file itself is 0600 and
// holds the IPC token, not a credential).

/** Env var names that survive scrubbing. Everything else is dropped. */
export const SCRUBBED_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "NODE_ENV",
  // Split-mode markers — data locations, never secrets.
  "NYX_PROCESS_MODE",
  "NYX_RUNTIME_DIR",
  "NYX_CONFIG_PATH",
  "NYX_PERSONA_ROOT",
  "NYX_SKIP_DOCKER",
  "NO_COLOR",
];

export interface ScrubOptions {
  /** Extra names to KEEP (e.g. NYX_ENV for the tools process posture check). */
  keep?: readonly string[];
  /** Extra entries to ADD (e.g. NYX_RUNTIME_DIR pointing at the token dir). */
  set?: Record<string, string>;
}

/**
 * Build a scrubbed environment for a child process: only allowlisted names
 * (plus opts.keep) survive, plus opts.set. Credential-looking names are
 * never in the result — and the result is a NEW object; the parent env is
 * not mutated.
 */
export function scrubEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  opts: ScrubOptions = {},
): Record<string, string> {
  const keep = new Set([...SCRUBBED_ENV_ALLOWLIST, ...(opts.keep ?? [])]);
  const out: Record<string, string> = {};
  for (const name of keep) {
    const value = source[name];
    if (value !== undefined) out[name] = value;
  }
  for (const [name, value] of Object.entries(opts.set ?? {})) {
    out[name] = value;
  }
  return out;
}
