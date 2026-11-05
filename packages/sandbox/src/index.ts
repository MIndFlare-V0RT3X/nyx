// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/sandbox — sandboxed execution providers for NYX tool runs.
//
// Path containment helpers (paths.ts) are exported for reuse by @nyx/tools;
// the local provider is development-only (no network isolation); the docker
// provider runs `--network none` containers, or Phase 6.1 "allowlist"
// containers whose only egress is the kernel-process proxy (egress_proxy/).

export { PathEscapeError, resolveContained, assertRealpathContained } from "./paths.js";
export { LocalSandboxProvider } from "./local.js";
export type { LocalSandboxOptions } from "./local.js";
export { DockerSandboxProvider, checkDocker } from "./docker.js";
export type { DockerSandboxOptions } from "./docker.js";
export { SandboxProviders, createDefaultSandboxRegistry } from "./registry.js";
// Phase 4 §4: the fork capability + the artifact handoff directory.
export {
  ARTIFACTS_DIR,
  ensureArtifactsDir,
  forkSandbox,
  isForkable,
  type ForkableSandbox,
} from "./fork.js";
// Phase 6.1: the kernel-process egress proxy (see docs/EGRESS-PROXY.md).
export { EgressProxyServer, DEFAULT_MAX_CONNECTIONS, parseConnectAuthority } from "./egress_proxy/proxy.js";
export type {
  EgressDecisionProvider,
  EgressDecision,
  EgressDecisionAllow,
  EgressDecisionDeny,
  EgressListenerContext,
  EgressConnectRequest,
  EgressListenerInfo,
  SandboxEgressBinding,
} from "./egress_proxy/types.js";
export {
  egressNetworkCreateArgs,
  egressNetworkGatewayInspectArgs,
  egressNetworkConnectedContainersArgs,
  egressNetworkDisconnectArgs,
  egressNetworkRmArgs,
  containerRunArgs,
} from "./docker.js";
