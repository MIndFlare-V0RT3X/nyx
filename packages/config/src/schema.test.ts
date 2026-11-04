// SPDX-License-Identifier: AGPL-3.0-or-later
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PolicyRule } from "@nyx/protocol";
import { configSchema, chainSchema } from "./schema.js";
import type { NyxPolicyRuleConfig } from "./schema.js";

// A router section is the one thing no config may omit.
const MINIMAL = {
  router: {
    default: {
      chain: [{ provider: "mock", model: "m" }],
    },
  },
};

describe("configSchema", () => {
  it("accepts the minimal config and applies section defaults", () => {
    const result = configSchema.safeParse(MINIMAL);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const cfg = result.data;
    expect(cfg.providers).toEqual({});
    expect(cfg.policy).toEqual({ rules: [] });
    expect(cfg.sandbox).toEqual({
      provider: "docker",
      image: "alpine:3.20",
      workdir_root: join(homedir(), ".nyx/sandboxes"),
    });
    expect(cfg.memory).toEqual({ root: join(homedir(), ".nyx/memory"), episode_expiry_days: 30 });
    expect(cfg.persona).toEqual({ default_id: "default", root: "./personas" });
    expect(cfg.logging).toEqual({
      level: "info",
      redact: ["api_key", "authorization", "token", "secret"],
    });
    expect(cfg.owner_id).toBe("owner");
    expect(cfg.server).toBeUndefined();
    expect(cfg.router.default.fallback_on).toEqual(["rate_limit", "server_error", "timeout"]);
    expect(cfg.router.rules).toEqual([]);
    expect(cfg.router.budgets).toEqual({
      per_turn_tokens: 200_000,
      per_session_tokens: 5_000_000,
      on_exceed: "ask",
    });
  });

  it("rejects an unknown top-level key with the typo in the issue", () => {
    const result = configSchema.safeParse({ ...MINIMAL, serve: { port: 8787 } });
    expect(result.success).toBe(false);
    if (result.success) return;
    const unknown = result.error.issues.find((i) => i.code === "unrecognized_keys");
    expect(unknown?.keys).toContain("serve");
  });

  it("requires the router section", () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.length === 1 && i.path[0] === "router")).toBe(
      true,
    );
  });

  it("requires server.auth.owner_token when server is present", () => {
    const result = configSchema.safeParse({ ...MINIMAL, server: { auth: {} } });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("server.auth.owner_token");
  });

  it("rejects the reserved owner actor in server.auth.tokens", () => {
    const result = configSchema.safeParse({
      ...MINIMAL,
      server: { auth: { owner_token: "t", tokens: { owner: "shadow" } } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join("."))).toContain("server.auth.tokens.owner");
  });

  it("rejects a bad provider kind at the provider's field path", () => {
    const result = configSchema.safeParse({
      ...MINIMAL,
      providers: { local: { kind: "groq" } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues[0];
    expect(issue?.path.join(".")).toBe("providers.local.kind");
  });

  it("rejects a malformed base_url", () => {
    const result = configSchema.safeParse({
      ...MINIMAL,
      providers: {
        local: { kind: "openai", base_url: "not a url", models: [] },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join("."))).toContain("providers.local.base_url");
  });

  it("requires api_key_env for anthropic but not for openai", () => {
    const ok = configSchema.safeParse({
      ...MINIMAL,
      providers: {
        local: { kind: "openai", base_url: "http://127.0.0.1:8080/v1", models: [] },
        cloud: { kind: "anthropic", api_key_env: "NYX_KEY", models: [] },
      },
    });
    expect(ok.success).toBe(true);

    const bad = configSchema.safeParse({
      ...MINIMAL,
      providers: { cloud: { kind: "anthropic", models: [] } },
    });
    expect(bad.success).toBe(false);
    if (bad.success) return;
    expect(bad.error.issues.map((i) => i.path.join("."))).toContain("providers.cloud.api_key_env");
  });

  it("mock providers take nothing else", () => {
    const withExtra = configSchema.safeParse({
      ...MINIMAL,
      providers: { mock: { kind: "mock", base_url: "http://x/" } },
    });
    expect(withExtra.success).toBe(false);
  });

  it("rejects an unknown capability in a model's supports list", () => {
    const result = configSchema.safeParse({
      ...MINIMAL,
      providers: {
        local: {
          kind: "openai",
          base_url: "http://127.0.0.1:8080/v1",
          models: [{ id: "m", context_window: 1, max_output: 1, supports: ["streaming"] }],
        },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join("."))).toContain(
      "providers.local.models.0.supports.0",
    );
  });

  it("applies the empty supports default and validates model fields", () => {
    const result = configSchema.safeParse({
      ...MINIMAL,
      providers: {
        local: {
          kind: "openai",
          base_url: "http://127.0.0.1:8080/v1",
          models: [{ id: "m", context_window: 8, max_output: 4 }],
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const local = result.data.providers.local;
    if (local?.kind !== "openai") throw new Error("expected openai provider");
    expect(local.models[0]?.supports).toEqual([]);
  });
});

describe("chainSchema", () => {
  it("requires at least one step", () => {
    expect(chainSchema.safeParse([]).success).toBe(false);
    expect(chainSchema.safeParse([{ provider: "mock", model: "m" }]).success).toBe(true);
  });

  it("rejects unknown keys inside a chain step", () => {
    const result = chainSchema.safeParse([{ provider: "mock", model: "m", modle: "typo" }]);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some(
        (i) =>
          i.code === "unrecognized_keys" && i.path.join(".") === "0" && i.keys.includes("modle"),
      ),
    ).toBe(true);
  });

  it("accepts the documented optional overrides", () => {
    const result = chainSchema.safeParse([
      {
        provider: "zai",
        model: "glm-4.9",
        reasoning_effort: "low",
        max_tokens: 4096,
        tool_choice: "none",
      },
    ]);
    expect(result.success).toBe(true);
  });
});

describe("policy rule mirror", () => {
  it("accepts a full PolicyRule and infers the protocol-compatible shape", () => {
    const rule: PolicyRule = {
      id: "allow-r0",
      match: {
        risk: "R0",
        capability: ["fs.read"],
        tool: ["fs.read", "fs.list"],
        owner_only: false,
        path_prefix: "/tmp",
        host: "example.test",
      },
      decision: "allow",
      reason: "read-only",
      immutable: true,
    };
    const result = configSchema.safeParse({
      ...MINIMAL,
      policy: { rules: [rule] },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const mirrored: NyxPolicyRuleConfig = result.data.policy.rules[0] as NyxPolicyRuleConfig;
    expect(mirrored.decision).toBe("allow");
    // The mirror is bidirectionally assignable with the protocol type.
    const roundTrip: PolicyRule = mirrored;
    expect(roundTrip.id).toBe("allow-r0");
  });

  it("rejects an unknown match key (field names must stay identical)", () => {
    const result = configSchema.safeParse({
      ...MINIMAL,
      policy: { rules: [{ id: "x", match: { tasky: "y" }, decision: "allow" }] },
    });
    expect(result.success).toBe(false);
  });
});

describe("tilde expansion", () => {
  it("expands a leading ~ to os.homedir() at parse time", () => {
    const result = configSchema.safeParse({
      ...MINIMAL,
      sandbox: { workdir_root: "~/custom-sandboxes" },
      memory: { root: "~" },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sandbox.workdir_root).toBe(join(homedir(), "custom-sandboxes"));
    expect(result.data.memory.root).toBe(homedir());
  });

  it("expands the default roots too", () => {
    const result = configSchema.safeParse(MINIMAL);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.memory.root).toBe(join(homedir(), ".nyx/memory"));
  });

  it("leaves non-tilde paths untouched", () => {
    const result = configSchema.safeParse({
      ...MINIMAL,
      memory: { root: "/var/lib/nyx/memory" },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.memory.root).toBe("/var/lib/nyx/memory");
  });
});

describe("Phase 1 sections: lanes, channels, heartbeat (optional)", () => {
  it("parses all three when present", () => {
    const result = configSchema.safeParse({
      ...MINIMAL,
      lanes: {
        max_concurrent_global: 8,
        max_concurrent_per_session: 1,
        heartbeat_serialized_with_interactive: true,
      },
      channels: {
        webhook: {
          enabled: true,
          path: "/webhook",
          bind: "127.0.0.1",
          port: 8089,
          allowed_owners: ["owner:primary"],
          reply_timeout_ms: 60000,
        },
        telegram: {
          enabled: false,
          bot_token_env: "NYX_TELEGRAM_BOT_TOKEN",
          allowed_user_ids: [123456789],
          poll_timeout_s: 25,
          edit_interval_ms: 1500,
        },
      },
      heartbeat: {
        enabled: false,
        specs: [
          {
            id: "memory-review",
            schedule: "0 3 * * *",
            prompt: "Review the last 24 hours of memory.",
            priority: "heartbeat",
            enabled: false,
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.lanes?.max_concurrent_global).toBe(8);
    expect(result.data.channels?.webhook?.allowed_owners).toEqual(["owner:primary"]);
    expect(result.data.heartbeat?.specs).toHaveLength(1);
    // Absent → undefined (code defaults apply).
    const bare = configSchema.safeParse(MINIMAL);
    expect(bare.success).toBe(true);
    if (!bare.success) return;
    expect(bare.data.lanes).toBeUndefined();
    expect(bare.data.channels).toBeUndefined();
    expect(bare.data.heartbeat).toBeUndefined();
  });

  it("rejects malformed sections (unknown keys, bad types, wrong path shape)", () => {
    expect(
      configSchema.safeParse({ ...MINIMAL, lanes: { max_concurrent_global: 0 } }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({
        ...MINIMAL,
        channels: { webhook: { enabled: true, path: "no-slash", bind: "127.0.0.1", port: 1, allowed_owners: [], reply_timeout_ms: 1 } },
      }).success,
    ).toBe(false);
    // Note: cron SYNTAX is validated by @nyx/runtime's parseCron when the
    // scheduler is constructed (server startup fails loudly on a bad spec);
    // the config schema checks structure only.
    expect(
      configSchema.safeParse({
        ...MINIMAL,
        heartbeat: { enabled: true, specs: [{ id: "x", schedule: "0 3 * * *", priority: "heartbeat", enabled: true }] },
      }).success,
    ).toBe(false); // missing prompt
    expect(
      configSchema.safeParse({ ...MINIMAL, unknown_section: {} }).success,
    ).toBe(false);
  });
});
