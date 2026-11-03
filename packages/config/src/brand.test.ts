// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { BRAND, DEFAULT_CONFIG_PATH } from "./brand.js";

describe("BRAND", () => {
  it("carries the canonical product identity", () => {
    expect(BRAND.name).toBe("nyx");
    expect(BRAND.displayName).toBe("Nyx");
    expect(BRAND.configFileName).toBe("nyx.config.yaml");
  });

  it("is frozen (mutation throws in strict mode)", () => {
    expect(Object.isFrozen(BRAND)).toBe(true);
    const mutable = BRAND as { name: string };
    expect(() => {
      mutable.name = "other";
    }).toThrow(TypeError);
    expect(BRAND.name).toBe("nyx");
  });

  it("derives the default config path from the brand", () => {
    expect(DEFAULT_CONFIG_PATH).toBe("./nyx.config.yaml");
    expect(DEFAULT_CONFIG_PATH).toContain(BRAND.configFileName);
  });
});
