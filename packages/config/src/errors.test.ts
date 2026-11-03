// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ConfigError, formatFieldPath, redactEnvValues } from "./errors.js";

describe("ConfigError", () => {
  it("is an Error with the typed code validation_failed", () => {
    const err = new ConfigError("boom at /tmp/x/nyx.config.yaml");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.code).toBe("validation_failed");
    expect(err.name).toBe("ConfigError");
    expect(err.message).toBe("boom at /tmp/x/nyx.config.yaml");
  });

  it("preserves the cause", () => {
    const cause = new Error("original");
    const err = new ConfigError("wrapped", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("formatFieldPath", () => {
  it("joins keys with dots and array indices with brackets", () => {
    expect(formatFieldPath([])).toBe("(root)");
    expect(formatFieldPath(["server"])).toBe("server");
    expect(formatFieldPath(["server", "auth", "owner_token"])).toBe("server.auth.owner_token");
    expect(formatFieldPath(["router", "default", "chain", 0, "provider"])).toBe(
      "router.default.chain[0].provider",
    );
    expect(formatFieldPath(["providers", "local", "models", 2, "supports", 1])).toBe(
      "providers.local.models[2].supports[1]",
    );
  });
});

describe("redactEnvValues", () => {
  it("replaces env-resolved values wherever they appear", () => {
    expect(redactEnvValues("received 'sekrit'", ["sekrit"])).toBe(
      "received '<redacted env value>'",
    );
  });

  it("replaces longer values first, ignores empty values, and never re-redacts the placeholder", () => {
    expect(redactEnvValues("a b ab", ["a", "ab", ""])).toBe(
      "<redacted env value> b <redacted env value>",
    );
  });

  it("escapes regex metacharacters in env values", () => {
    expect(redactEnvValues("key=a.b*c", ["a.b*c"])).toBe("key=<redacted env value>");
  });

  it("leaves text without env values untouched", () => {
    expect(redactEnvValues("Invalid url", ["tok"])).toBe("Invalid url");
  });
});
