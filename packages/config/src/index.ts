// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/config — loads, validates, and freezes nyx.config.yaml, and owns the
// single BRAND constant. This module is the package's whole public surface.

export { BRAND, DEFAULT_CONFIG_PATH } from "./brand.js";
export { configSchema } from "./schema.js";
export type {
  NyxConfig,
  NyxServerConfig,
  NyxProviderConfig,
  NyxModelConfig,
  NyxChainStep,
  NyxRouteRule,
  NyxRouterConfig,
  NyxPolicyRuleConfig,
} from "./schema.js";
export { interpolateEnvVars } from "./interpolate.js";
export type { InterpolationResult } from "./interpolate.js";
export { loadConfig, validateEgressPolicy, validatePluginPolicy } from "./loader.js";
export type { LoadConfigOptions } from "./loader.js";
export { ConfigError } from "./errors.js";
export type { ConfigErrorCode } from "./errors.js";
