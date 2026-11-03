// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { CapabilityError, SECTION_ORDER } from "./index.js";

describe("protocol surface", () => {
  it("exposes the fixed 8-section assembly order", () => {
    expect(SECTION_ORDER).toEqual([
      "BASE_PREAMBLE",
      "CONTRACT",
      "SOUL",
      "USER",
      "MEMORY_CATALOG",
      "SKILLS_CATALOG",
      "TOOLS_CATALOG",
      "SESSION_CONTEXT",
    ]);
  });

  it("CapabilityError carries plugin and capability", () => {
    const err = new CapabilityError("test-plugin", "net.egress");
    expect(err).toBeInstanceOf(Error);
    expect(err.plugin).toBe("test-plugin");
    expect(err.capability).toBe("net.egress");
    expect(err.code).toBe("capability");
  });
});
