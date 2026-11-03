// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { ToolCall, ToolDefinition } from "@nyx/protocol";
import { ToolRouterImpl } from "./router.js";

function def(name: string): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    input_schema: { type: "object" },
    risk: "R0",
    capabilities: [],
    handler: `test:${name}`,
  };
}

function call(name: string): ToolCall {
  return { call_id: "c1", name, input: {} };
}

describe("ToolRouterImpl", () => {
  it("returns the exact-name match", () => {
    const router = new ToolRouterImpl();
    const available = [def("fs.read"), def("fs.write"), def("web.fetch")];
    expect(router.select(call("fs.write"), available)?.name).toBe("fs.write");
  });

  it("returns null for an unknown tool", () => {
    const router = new ToolRouterImpl();
    expect(router.select(call("does.not.exist"), [def("fs.read")])).toBeNull();
  });

  it("does not fuzzy-match: prefixes, suffixes, and case changes are unknown", () => {
    const router = new ToolRouterImpl();
    const available = [def("fs.read")];
    expect(router.select(call("fs"), available)).toBeNull();
    expect(router.select(call("fs.read.extra"), available)).toBeNull();
    expect(router.select(call("FS.READ"), available)).toBeNull();
    expect(router.select(call("fs.read "), available)).toBeNull();
  });

  it("returns null against an empty catalog", () => {
    const router = new ToolRouterImpl();
    expect(router.select(call("fs.read"), [])).toBeNull();
  });
});
