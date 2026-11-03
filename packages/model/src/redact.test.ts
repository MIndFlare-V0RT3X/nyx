// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets, scrubSecretText, toSafeSerializedError } from "./redact.js";

describe("redactSecrets", () => {
  it("redacts values of sensitive keys at any depth, case-insensitively", () => {
    const input = {
      api_key: "k1",
      "X-API-Key": "k2",
      authorization: "Bearer k3",
      autoToken: "k4",
      SOME_SECRET: "k5",
      credentials_file: "k6",
      nested: {
        deep: [{ access_token: "k7", name: "keep-me" }],
      },
      fine: "untouched",
    };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.api_key).toBe(REDACTED);
    expect(out["X-API-Key"]).toBe(REDACTED);
    expect(out.authorization).toBe(REDACTED);
    expect(out.autoToken).toBe(REDACTED);
    expect(out.SOME_SECRET).toBe(REDACTED);
    expect(out.credentials_file).toBe(REDACTED);
    expect(out.fine).toBe("untouched");
    const nested = out.nested as { deep: Array<Record<string, unknown>> };
    expect(nested.deep[0]?.access_token).toBe(REDACTED);
    expect(nested.deep[0]?.name).toBe("keep-me");
  });

  it("deep-clones: the input object is not mutated", () => {
    const input = { api_key: "k1", inner: { secret: "k2" } };
    const out = redactSecrets(input) as { api_key: string; inner: { secret: string } };
    expect(out.api_key).toBe(REDACTED);
    expect(out.inner.secret).toBe(REDACTED);
    expect(input.api_key).toBe("k1");
    expect(input.inner.secret).toBe("k2");
    expect(out).not.toBe(input);
    expect(out.inner).not.toBe(input.inner);
  });

  it("handles arrays, primitives, null, Maps and Sets", () => {
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets([{ token: "t" }, "x"])).toEqual([{ token: REDACTED }, "x"]);
    const map = redactSecrets(new Map<string, unknown>([["api_key", "k"], ["n", 1]])) as Map<
      string,
      unknown
    >;
    expect(map.get("api_key")).toBe(REDACTED);
    expect(map.get("n")).toBe(1);
    const set = redactSecrets(new Set([1, "s"])) as Set<unknown>;
    expect([...set]).toEqual([1, "s"]);
  });

  it("passes primitives inside arrays through unchanged", () => {
    expect(redactSecrets(["a", 1, true])).toEqual(["a", 1, true]);
  });
});

describe("scrubSecretText", () => {
  it("redacts sk- style tokens", () => {
    expect(scrubSecretText("boom sk-abcdefgh12345678 tail")).toBe("boom sk-[redacted] tail");
    expect(scrubSecretText("no keys here")).toBe("no keys here");
  });

  it("redacts inline json key/value pairs", () => {
    expect(scrubSecretText('req failed: {"api_key":"hunter2"}')).toBe(
      'req failed: {"api_key": "[redacted]"}',
    );
  });
});

describe("toSafeSerializedError", () => {
  it("keeps name/code/retryable of coded Errors and scrubs the message", () => {
    const err = Object.assign(new Error("call failed with key sk-abcdefgh12345678"), {
      code: "rate_limit",
      retryable: true,
    });
    const out = toSafeSerializedError(err);
    expect(out.name).toBe("Error");
    expect(out.code).toBe("rate_limit");
    expect(out.retryable).toBe(true);
    expect(out.message).not.toContain("sk-abcdefgh12345678");
    expect(out.message).toContain("sk-[redacted]");
  });

  it("preserves code/retryable when given a plain serialized error object", () => {
    const out = toSafeSerializedError({
      name: "ProviderError",
      message: "upstream is sad",
      code: "server_error",
      retryable: true,
    });
    expect(out).toMatchObject({ name: "ProviderError", message: "upstream is sad", code: "server_error", retryable: true });
  });

  it("redacts structured secrets embedded in message text", () => {
    const out = toSafeSerializedError(new Error('denied for {"Authorization":"Bearer k"}'));
    expect(out.message).toBe('denied for {"Authorization": "[redacted]"}');
  });

  it("redacts secrets carried in structured fields of object errors", () => {
    const err = Object.assign(new Error("connection dropped"), {
      code: "server_error",
      retryable: true,
      request_detail: { api_key: "super-secret", url: "http://x/v1" },
    });
    // protocol toSerializedError only reads known fields; the round-trip must
    // still never leak the key through message/stack.
    const out = toSafeSerializedError(err);
    expect(out.message).toBe("connection dropped");
    expect(JSON.stringify(out)).not.toContain("super-secret");
  });

  it("handles non-error throws", () => {
    expect(toSafeSerializedError("just a string")).toMatchObject({
      name: "UnknownError",
      message: "just a string",
    });
    expect(toSafeSerializedError(undefined).name).toBe("UnknownError");
  });
});
