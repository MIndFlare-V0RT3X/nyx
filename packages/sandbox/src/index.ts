// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/sandbox — sandboxed execution providers for NYX tool runs.
//
// Path containment helpers (paths.ts) are exported for reuse by @nyx/tools;
// the local provider is development-only (no network isolation); the docker
// provider runs Phase 0 `--network none` containers via the docker CLI.

export { PathEscapeError, resolveContained, assertRealpathContained } from "./paths.js";
export { LocalSandboxProvider } from "./local.js";
export type { LocalSandboxOptions } from "./local.js";
export { DockerSandboxProvider, checkDocker } from "./docker.js";
export type { DockerSandboxOptions } from "./docker.js";
export { SandboxProviders, createDefaultSandboxRegistry } from "./registry.js";
