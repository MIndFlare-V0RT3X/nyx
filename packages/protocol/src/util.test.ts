// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { canonicalJson, mergeUsage, toSerializedError } from "./util.js";

describe("canonicalJson", () => {
  it("sorts object keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("is order-insensitive for logically equal objects", () => {
    expect(canonicalJson({ x: 1, y: [2, 3] })).toBe(canonicalJson({ y: [2, 3], x: 1 }));
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined values", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("escapes strings identically to JSON.stringify", () => {
    expect(canonicalJson({ path: 'a"b\\c\n' })).toBe(JSON.stringify({ path: 'a"b\\c\n' }));
  });

  it("produces identical digests for nested reordered input", () => {
    const a = { tool: "fs.read", input: { path: "x.txt", opts: { tail: 1, head: 2 } }, risk: "R0" };
    const b = { risk: "R0", input: { opts: { head: 2, tail: 1 }, path: "x.txt" }, tool: "fs.read" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe("toSerializedError", () => {
  it("serializes Error instances with name and message", () => {
    const e = toSerializedError(new Error("boom"));
    expect(e.name).toBe("Error");
    expect(e.message).toBe("boom");
    expect(e.stack).toBeTruthy();
  });

  it("keeps code and retryable when present", () => {
    const err = new Error("rate limited");
    (err as Error & { code: string }).code = "rate_limit";
    (err as Error & { retryable: boolean }).retryable = true;
    const e = toSerializedError(err);
    expect(e.code).toBe("rate_limit");
    expect(e.retryable).toBe(true);
  });

  it("handles non-error throws", () => {
    expect(toSerializedError("nope").message).toBe("nope");
    expect(toSerializedError(42).name).toBe("UnknownError");
  });
});

describe("mergeUsage", () => {
  it("sums and derives totals", () => {
    const merged = mergeUsage(
      { input_tokens: 10, output_tokens: 5 },
      { input_tokens: 1, output_tokens: 2, reasoning_tokens: 3 },
      undefined,
    );
    expect(merged.input_tokens).toBe(11);
    expect(merged.output_tokens).toBe(7);
    expect(merged.reasoning_tokens).toBe(3);
    expect(merged.total_tokens).toBe(21);
  });
});
