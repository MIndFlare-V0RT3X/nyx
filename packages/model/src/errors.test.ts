// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { APIUserAbortError, OpenAIError } from "openai";
import { APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { classifyProviderError, ProviderError, toProviderError } from "./errors.js";
import { toSafeSerializedError } from "./redact.js";

function withStatus(status: number, message = "http fail"): Error {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

describe("classifyProviderError", () => {
  it("maps 429 to rate_limit retryable", () => {
    const out = classifyProviderError(withStatus(429, "Too many requests"));
    expect(out.code).toBe("rate_limit");
    expect(out.retryable).toBe(true);
  });

  it("maps 5xx to server_error retryable", () => {
    for (const status of [500, 502, 503, 529]) {
      expect(classifyProviderError(withStatus(status)).code).toBe("server_error");
      expect(classifyProviderError(withStatus(status)).retryable).toBe(true);
    }
  });

  it("maps 401/403 to auth non-retryable", () => {
    for (const status of [401, 403]) {
      expect(classifyProviderError(withStatus(status)).code).toBe("auth");
      expect(classifyProviderError(withStatus(status)).retryable).toBe(false);
    }
  });

  it("maps SDK timeout errors to timeout retryable", () => {
    const out = classifyProviderError(new APIConnectionTimeoutError());
    expect(out.code).toBe("timeout");
    expect(out.retryable).toBe(true);
  });

  it("maps AbortSignal.timeout-style aborts to timeout, not aborted", () => {
    const cause = new Error("signal timed out");
    cause.name = "TimeoutError";
    const err = new APIUserAbortError();
    (err as unknown as { cause: unknown }).cause = cause;
    const out = classifyProviderError(err);
    expect(out.code).toBe("timeout");
    expect(out.retryable).toBe(true);
  });

  it("maps user aborts to aborted non-retryable", () => {
    for (const err of [
      new APIUserAbortError(),
      Object.assign(new Error("aborted op"), { name: "AbortError" }),
    ]) {
      const out = classifyProviderError(err);
      expect(out.code).toBe("aborted");
      expect(out.retryable).toBe(false);
    }
  });

  it("falls back to provider_error non-retryable for unknown failures", () => {
    const out = classifyProviderError(new OpenAIError("mystery"));
    expect(out.code).toBe("provider_error");
    expect(out.retryable).toBe(false);
  });

  it("preserves codes already carried by a ProviderError", () => {
    const out = classifyProviderError(
      new ProviderError("mock script exhausted", { code: "provider_error" }),
    );
    expect(out.code).toBe("provider_error");
    expect(out.retryable).toBe(false);

    const rl = classifyProviderError(
      new ProviderError("slow down", { code: "rate_limit", retryable: true }),
    );
    expect(rl).toMatchObject({ code: "rate_limit", retryable: true });
  });
});

describe("toProviderError", () => {
  it("wraps the original error as cause and carries the classified fields", () => {
    const original = withStatus(429, "quota");
    const wrapped = toProviderError(original);
    expect(wrapped).toBeInstanceOf(ProviderError);
    expect(wrapped.code).toBe("rate_limit");
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.message).toBe("quota");
    expect(wrapped.cause).toBe(original);
  });
});

describe("ProviderError", () => {
  it("serializes through toSafeSerializedError with code and retryable intact", () => {
    const err = new ProviderError("rate limited with key sk-abcdefgh12345678", {
      code: "rate_limit",
      retryable: true,
    });
    const ser = toSafeSerializedError(err);
    expect(ser.code).toBe("rate_limit");
    expect(ser.retryable).toBe(true);
    expect(ser.message).not.toContain("sk-abcdefgh12345678");
  });
});
