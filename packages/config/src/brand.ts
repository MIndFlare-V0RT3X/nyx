// SPDX-License-Identifier: AGPL-3.0-or-later
// The single source of truth for the product name. Every reference to the
// product name in this repo centralizes here — never hardcode "nyx" elsewhere.

/** Frozen brand descriptor. Identity, not configuration. */
export const BRAND = Object.freeze({
  /** Machine name: package prefix, CLI binary, config file stem. */
  name: "nyx",
  /** Human-facing display name. */
  displayName: "Nyx",
  /** The one config file NYX reads at startup. */
  configFileName: "nyx.config.yaml",
} as const);

/** Where loadConfig() looks when no explicit path is given. */
export const DEFAULT_CONFIG_PATH = `./${BRAND.configFileName}`;
