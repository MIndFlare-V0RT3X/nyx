// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 4 §4 — sandbox forking: the fork-per-child default.
//
// A forked sandbox starts as a FILESYSTEM COPY of its parent and shares
// nothing after that: no bind mounts, no shared dirs, no live handles —
// writes on either side are invisible to the other (hard rule: no implicit
// filesystem sharing). The ONLY channel from a child back to its parent is
// an explicit, hash-chained artifact handoff (see @nyx/subagents'
// subagent_artifact / subagent_read_artifact tools).
//
// `fork()` is a CAPABILITY on the concrete sandbox classes, deliberately
// NOT on the frozen @nyx/protocol Sandbox interface: providers that cannot
// fork (interface stubs, test fakes) simply don't expose it, and
// forkSandbox() refuses them LOUDLY — never a silent fallback to sharing,
// which would reintroduce exactly the implicit sharing this phase removes.

import type { Sandbox } from "@nyx/protocol";

/** The artifact handoff directory inside every forked sandbox. */
export const ARTIFACTS_DIR = "artifacts";

/**
 * A sandbox that can fork itself. Implemented by LocalSandbox (cp -a) and
 * DockerSandbox (commit → temp image → run); interface stubs (E2B,
 * Daytona) implement provision() only and are refused by forkSandbox.
 */
export interface ForkableSandbox extends Sandbox {
  fork(): Promise<Sandbox>;
}

/** Type guard for the fork capability. */
export function isForkable(sandbox: Sandbox): sandbox is ForkableSandbox {
  return typeof (sandbox as { fork?: unknown }).fork === "function";
}

/**
 * Fork a sandbox. Throws not_supported for non-forkable sandboxes — a
 * caller configured for fork mode must never quietly degrade to sharing.
 */
export async function forkSandbox(parent: Sandbox): Promise<Sandbox> {
  if (!isForkable(parent)) {
    const err = new Error(
      `sandbox of type ${parent.constructor.name} does not support forking; ` +
        'subagents.sandbox_sharing "fork" requires the local or docker provider',
    ) as Error & { code: string };
    err.code = "not_supported";
    throw err;
  }
  return parent.fork();
}

/**
 * Prepare the artifact handoff directory inside a (forked) sandbox. Fresh by
 * construction: the fork copied the parent's whole workdir — including any
 * artifacts IT read from earlier children — and that inherited channel
 * content must not leak back out as if this child had published it.
 */
export async function ensureArtifactsDir(sandbox: Sandbox): Promise<void> {
  const r = await sandbox.exec(`rm -rf ${ARTIFACTS_DIR} && mkdir -p ${ARTIFACTS_DIR}`);
  if (r.exit_code !== 0) {
    const err = new Error(
      `could not prepare ${ARTIFACTS_DIR}/ in sandbox ${sandbox.id}: ${r.stderr}`,
    ) as Error & { code: string };
    err.code = "provider_error";
    throw err;
  }
}
