// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/split — the Phase 7.3 process split. Three binaries:
//
//   nyx-kernel  the trusted zone: config, credential vault, policy engine,
//               approval engine, audit chain, nyx.db (sessions + tasks),
//               memory store. Serves the kernel socket.
//   nyx-agent   the semi-trusted zone: agent loop, prompt assembly, persona,
//               model router, the remote views. Holds no credentials, no db
//               handle, no fs outside its workdir. Client of both sockets.
//   nyx-tools   the untrusted zone: tool registry, tool runtime, sandbox
//               provider. Client of the kernel socket (policy/approvals),
//               server on the tools socket (tool.execute).
//
// Single mode (NYX_PROCESS_MODE=single, the default) is byte-identical to
// Phase 6: the apps/server and apps/cli wiring composes everything in one
// process, unchanged. The split is a DEPLOYMENT change, not an architecture
// change — the seams were always there; now an OS boundary enforces them.

export { startKernelHost, type KernelHost, type KernelHostOptions } from "./kernel-host.js";
export { startToolsHost, type ToolsHost, type ToolsHostOptions } from "./tools-host.js";
export {
  runSplitTurn,
  loadSplitConfig,
  type AgentRunOptions,
  type AgentRunResult,
} from "./agent-main.js";
export {
  RemoteApprovalEngine,
  RemoteMemoryStore,
  RemotePolicyEngine,
  RemoteSessionStore,
  RemoteToolRuntime,
  injectKernelCredential,
} from "./remote.js";
export {
  CredentialVault,
  CREDENTIAL_TOKEN_TTL_MS,
  type ScopedCredential,
  type VaultAuditSink,
} from "./credential-vault.js";
export { ReusableMockProvider, ScriptedFileMockProvider } from "./mock-provider.js";
export {
  launchSplitStack,
  scrubAgentEnv,
  type SplitStack,
  type LaunchSplitOptions,
} from "./launch.js";
