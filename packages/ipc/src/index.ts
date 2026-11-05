// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/ipc — the Phase 7.3 process-split boundary: versioned JSON-RPC over
// token-authenticated unix sockets. The kernel process hosts one endpoint,
// the tools process another; the agent runtime is a client of both.

export {
  IPC_PROTOCOL_VERSION,
  type KernelRequest,
  type KernelRequestResult,
  type SessionCreateInput,
  type ToolsRequest,
  type ToolsRequestResult,
  type ToolExecuteRequest,
  type ToolExecuteResult,
  type HandshakeFrame,
  type HandshakeResponse,
  type RequestFrame,
  type ResponseFrame,
  type IpcResponse,
  type IpcError,
} from "./protocol.js";
export { IpcServer, IpcError_, type IpcServerOptions, type IpcRequestHandler } from "./server.js";
export { IpcClient, IpcClientError, type IpcClientOptions } from "./client.js";
export {
  generateIpcToken,
  writeTokenFile,
  rotateTokenFile,
  readTokenFile,
  runtimePaths,
  runtimeDirPaths,
  type TokenFile,
} from "./token.js";
export { SCRUBBED_ENV_ALLOWLIST, scrubEnvironment, type ScrubOptions } from "./env.js";
