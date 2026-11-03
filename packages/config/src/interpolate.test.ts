// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { interpolateEnvVars } from "./interpolate.js";
import { ConfigError } from "./errors.js";

const FILE = "/virtual/nyx.config.yaml";

describe("interpolateEnvVars", () => {
  it("resolves a whole-string ${VAR} to the exact value", () => {
    const { value } = interpolateEnvVars({ token: "${TOK}" }, { TOK: "abc" }, FILE);
    expect(value).toEqual({ token: "abc" });
  });

  it("resolves embedded refs and concatenates", () => {
    const { value } = interpolateEnvVars(
      { base_url: "http://${HOST}:8080/${PATH_PART}" },
      { HOST: "llama", PATH_PART: "v1" },
      FILE,
    );
    expect(value).toEqual({ base_url: "http://llama:8080/v1" });
  });

  it("resolves repeated refs in one string", () => {
    const { value } = interpolateEnvVars({ x: "${A}-${A}" }, { A: "z" }, FILE);
    expect(value).toEqual({ x: "z-z" });
  });

  it("walks nested objects and arrays", () => {
    const tree = {
      providers: {
        local: {
          kind: "openai",
          models: [{ id: "${MODEL}", supports: ["${CAP}"] }],
        },
      },
      list: ["${A}", { deep: "${B}" }],
      number: 42,
      flag: false,
      nothing: null,
    };
    const { value } = interpolateEnvVars(tree, { MODEL: "m1", CAP: "tools", A: "a", B: "b" }, FILE);
    expect(value).toEqual({
      providers: {
        local: {
          kind: "openai",
          models: [{ id: "m1", supports: ["tools"] }],
        },
      },
      list: ["a", { deep: "b" }],
      number: 42,
      flag: false,
      nothing: null,
    });
  });

  it("never interpolates keys", () => {
    const { value } = interpolateEnvVars({ "${VAR}": "${VAR}" }, { VAR: "resolved" }, FILE);
    expect(value).toEqual({ "${VAR}": "resolved" });
  });

  it("leaves non-env dollar syntax untouched", () => {
    const { value } = interpolateEnvVars(
      { a: "$HOME", b: "${1BAD}", c: "${}", d: "costs $$5", e: "${ok-name}" },
      { HOME: "h" },
      FILE,
    );
    expect(value).toEqual({ a: "$HOME", b: "${1BAD}", c: "${}", d: "costs $$5", e: "${ok-name}" });
  });

  it("resolves an empty env value to the empty string", () => {
    const { value } = interpolateEnvVars({ token: "${EMPTY}" }, { EMPTY: "" }, FILE);
    expect(value).toEqual({ token: "" });
  });

  it("does not resolve inherited Object.prototype names", () => {
    // "toString" is not an own property of the env record, so it is treated
    // as a missing variable (never as the inherited function).
    expect(() => interpolateEnvVars({ x: "${toString}" }, {}, FILE)).toThrow(ConfigError);
    // An own property that shadows an inherited name still resolves normally.
    const { value } = interpolateEnvVars({ x: "${toString}" }, { toString: "own-value" }, FILE);
    expect(value).toEqual({ x: "own-value" });
  });

  it("throws ConfigError naming var, file, and field path for a missing var", () => {
    expect(() => interpolateEnvVars({ server: { auth: { owner_token: "${NOPE}" } } }, {}, FILE)).toThrow(
      ConfigError,
    );
    try {
      interpolateEnvVars({ server: { auth: { owner_token: "${NOPE}" } } }, {}, FILE);
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as ConfigError).message;
      expect(msg).toContain("NOPE");
      expect(msg).toContain(FILE);
      expect(msg).toContain("server.auth.owner_token");
    }
  });

  it("reports array indices in the field path", () => {
    const tree = { router: { default: { chain: [{ provider: "x" }, { model: "${MISSING}" }] } } };
    try {
      interpolateEnvVars(tree, {}, FILE);
      expect.unreachable("must throw");
    } catch (err) {
      expect((err as ConfigError).message).toContain("router.default.chain[1].model");
    }
  });

  it("collects resolved env values for redaction", () => {
    const { resolvedEnvValues } = interpolateEnvVars(
      { a: "${X}", b: ["${Y}", "${X}"] },
      { X: "x-value", Y: "y-value" },
      FILE,
    );
    expect(resolvedEnvValues).toContain("x-value");
    expect(resolvedEnvValues).toContain("y-value");
    expect(resolvedEnvValues).not.toContain("");
  });
});
