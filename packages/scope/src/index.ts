// SPDX-License-Identifier: AGPL-3.0-or-later
export { parseIPv4, parseIPv6, isIPLiteral, parseCidr, cidrContains, normalizeHost } from "./ip.js";
export type { CidrInfo } from "./ip.js";
export {
  validateTargets,
  checkTarget,
  checkResolvedTarget,
  makeScopeChecker,
  engagementSummary,
  parseUrlTarget,
} from "./engine.js";
export type { ResolvedAddress, UrlTargetPattern } from "./engine.js";
