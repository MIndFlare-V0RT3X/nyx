// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "./errors.js";
import { loadConfig } from "./loader.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
// Tests are colocated in src/, so the repo root is three levels up.
const EXAMPLE_CONFIG = fileURLToPath(new URL("../../../nyx.config.example.yaml", import.meta.url));

const tempDirs: string[] = [];

/** Write a config to a fresh tmpdir (cleaned up in afterAll) and return its path. */
async function tempConfig(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nyx-config-test-"));
  tempDirs.push(dir);
  const file = join(dir, "nyx.config.yaml");
  await writeFile(file, yaml, "utf8");
  return file;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Load expecting failure; return the ConfigError for assertions. */
async function loadExpectInvalid(yaml: string): Promise<ConfigError> {
  const file = await tempConfig(yaml);
  let err: unknown;
  try {
    await loadConfig(file);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConfigError);
  return err as ConfigError;
}

// The valid router block every invalid fixture carries so the only error
// reported is the one under test.
const ROUTER = [
  "router:",
  "  default:",
  "    chain:",
  "      - provider: mock",
  "        model: m",
].join("\n");

describe("loadConfig — golden files", () => {
  it("parses the sparse fixture and applies every documented default", async () => {
    const cfg = await loadConfig(join(FIXTURES_DIR, "minimal.config.yaml"), {
      env: { NYX_TEST_OWNER_TOKEN: "test-owner-token" },
    });

    expect(cfg.server).toBeDefined();
    expect(cfg.server?.host).toBe("127.0.0.1");
    expect(cfg.server?.port).toBe(8787);
    expect(cfg.server?.auth.owner_token).toBe("test-owner-token");
    expect(cfg.server?.auth.tokens).toEqual({});

    expect(cfg.providers.local?.kind).toBe("openai");

    expect(cfg.router.default.fallback_on).toEqual(["rate_limit", "server_error", "timeout"]);
    expect(cfg.router.rules).toEqual([]);
    expect(cfg.router.budgets).toEqual({
      per_turn_tokens: 200_000,
      per_session_tokens: 5_000_000,
      on_exceed: "ask",
    });

    expect(cfg.policy).toEqual({ rules: [] });
    expect(cfg.sandbox).toEqual({
      provider: "docker",
      image: "alpine:3.20",
      workdir_root: join(homedir(), ".nyx/sandboxes"),
    });
    expect(cfg.memory).toEqual({
      root: join(homedir(), ".nyx/memory"),
      episode_expiry_days: 30,
    });
    expect(cfg.persona).toEqual({ default_id: "default", root: "./personas" });
    expect(cfg.logging).toEqual({
      level: "info",
      redact: ["api_key", "authorization", "token", "secret"],
    });
    expect(cfg.owner_id).toBe("owner");
  });

  it("parses the full fixture into the exact expected frozen structure", async () => {
    const cfg = await loadConfig(join(FIXTURES_DIR, "full.config.yaml"));

    expect(cfg).toEqual({
      server: {
        host: "127.0.0.1",
        port: 9000,
        auth: {
          owner_token: "full-fixture-owner-token",
          tokens: { alice: "full-fixture-alice-token" },
        },
      },
      providers: {
        mock: { kind: "mock" },
        local: {
          kind: "openai",
          base_url: "http://127.0.0.1:8080/v1",
          models: [
            {
              id: "glm-4.9",
              context_window: 128_000,
              max_output: 8192,
              supports: ["tools", "streaming_tools"],
            },
          ],
        },
        cloud: {
          kind: "anthropic",
          base_url: "https://proxy.example.test/anthropic",
          api_key_env: "NYX_FULL_FIXTURE_KEY",
          models: [
            {
              id: "claude-sonnet-4-5",
              context_window: 200_000,
              max_output: 64_000,
              supports: ["tools", "vision", "reasoning", "json_schema"],
            },
          ],
        },
      },
      router: {
        default: {
          chain: [
            { provider: "local", model: "glm-4.9", reasoning_effort: "high", max_tokens: 8192 },
            { provider: "mock", model: "test-model", tool_choice: "none" },
          ],
          fallback_on: ["rate_limit", "timeout"],
        },
        rules: [
          {
            match: { task: "compaction" },
            chain: [
              { provider: "local", model: "glm-4.9", reasoning_effort: "low", max_tokens: 4096 },
            ],
          },
        ],
        budgets: { per_turn_tokens: 100_000, per_session_tokens: 2_000_000, on_exceed: "trim" },
      },
      policy: {
        rules: [
          { id: "allow-r0", match: { risk: "R0" }, decision: "allow", reason: "read-only tools" },
          {
            id: "ask-r4",
            match: { capability: ["credential.use", "host.access"], owner_only: true },
            decision: "ask",
          },
        ],
      },
      sandbox: { provider: "docker", image: "debian:12", workdir_root: "/var/lib/nyx/sandboxes" },
      memory: { root: "/var/lib/nyx/memory", episode_expiry_days: 14 },
      persona: { default_id: "main", root: "./personas" },
      logging: { level: "debug", redact: ["api_key", "authorization"] },
      subagents: {
        max_depth: 2,
        max_total_per_turn: 150_000,
        default_budget_tokens: 20_000,
        max_budget_tokens: 40_000,
        default_allowed_tools: ["fs.read", "fs.list", "web.fetch"],
        forbidden_tools: ["spawn_subagent", "spawn_subagent_v2", "shell.exec"],
        sandbox_sharing: "fork",
        retention_enabled: true,
        retention_days: 14,
        retention_scope: "subagent+failed",
        delete_after_days: 90,
        retention_schedule: "15 4 * * *",
      },
      tasks: {
        enabled: true,
        workers: 3,
        poll_interval_ms: 250,
        lease_ttl_ms: 120_000,
        renew_interval_ms: 15_000,
      },
      skills: {
        catalog_max_tokens: 1500,
        dirs: ["~/.nyx/skills", "/opt/nyx/skills"],
        pinned: ["deploy-runbook"],
        excluded: ["legacy-migrations"],
      },
      owner_id: "owner",
    });
  });

  it("treats a top-level null section as omitted (defaults apply)", async () => {
    const file = await tempConfig(["sandbox:", "logging:", ROUTER].join("\n"));
    const cfg = await loadConfig(file);
    expect(cfg.sandbox).toEqual({
      provider: "docker",
      image: "alpine:3.20",
      workdir_root: join(homedir(), ".nyx/sandboxes"),
    });
    expect(cfg.logging.level).toBe("info");
  });
});

describe("loadConfig — frozen output", () => {
  it("deep-freezes the config: mutation anywhere throws", async () => {
    const cfg = await loadConfig(join(FIXTURES_DIR, "full.config.yaml"));

    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.router.budgets)).toBe(true);
    expect(Object.isFrozen(cfg.router.default.chain)).toBe(true);
    expect(Object.isFrozen(cfg.server?.auth.tokens)).toBe(true);

    expect(() => {
      cfg.owner_id = "mutated";
    }).toThrow(TypeError);

    const step = cfg.router.default.chain[0];
    expect(step).toBeDefined();
    expect(() => {
      step!.provider = "mutated";
    }).toThrow(TypeError);

    expect(() => {
      cfg.logging.redact.push("mutated");
    }).toThrow(TypeError);

    expect(() => {
      (cfg.server?.auth.tokens as Record<string, string>).alice = "mutated";
    }).toThrow(TypeError);

    // The failed mutations changed nothing.
    expect(cfg.owner_id).toBe("owner");
    expect(cfg.router.default.chain[0]!.provider).toBe("local");
    expect(cfg.logging.redact).toEqual(["api_key", "authorization"]);
  });
});

describe("loadConfig — invalid configs", () => {
  it("rejects a bad provider kind with file path and field path", async () => {
    const err = await loadExpectInvalid(
      ["providers:", "  local:", "    kind: groq", ROUTER].join("\n"),
    );
    expect(err.code).toBe("validation_failed");
    expect(err.message).toContain("nyx.config.yaml");
    expect(err.message).toContain("providers.local.kind");
  });

  it("rejects a typo'd top-level key, naming the typo", async () => {
    const err = await loadExpectInvalid(["serve:", "  port: 8787", ROUTER].join("\n"));
    expect(err.message).toContain("nyx.config.yaml");
    expect(err.message).toContain("serve");
  });

  it("rejects a bad enum with file path and field path", async () => {
    const err = await loadExpectInvalid(["logging:", "  level: verbose", ROUTER].join("\n"));
    expect(err.message).toContain("nyx.config.yaml");
    expect(err.message).toContain("logging.level");
  });

  it("rejects an openai provider without base_url (missing required field)", async () => {
    const err = await loadExpectInvalid(
      ["providers:", "  local:", "    kind: openai", "    models: []", ROUTER].join("\n"),
    );
    expect(err.message).toContain("nyx.config.yaml");
    expect(err.message).toContain("providers.local.base_url");
  });

  it("rejects server without owner_token when the section is present", async () => {
    const err = await loadExpectInvalid(["server:", "  auth: {}", ROUTER].join("\n"));
    expect(err.message).toContain("nyx.config.yaml");
    expect(err.message).toContain("server.auth.owner_token");
  });

  it("rejects a chain step missing provider at the spec's example path", async () => {
    const err = await loadExpectInvalid(
      ["router:", "  default:", "    chain:", "      - model: only-model"].join("\n"),
    );
    expect(err.message).toContain("nyx.config.yaml");
    expect(err.message).toContain("router.default.chain[0].provider");
  });

  it("rejects a malformed URL with file path and field path", async () => {
    const err = await loadExpectInvalid(
      [
        "providers:",
        "  local:",
        "    kind: openai",
        "    base_url: not a url",
        "    models: []",
        ROUTER,
      ].join("\n"),
    );
    expect(err.message).toContain("nyx.config.yaml");
    expect(err.message).toContain("providers.local.base_url");
  });

  it("rejects an empty default chain", async () => {
    const err = await loadExpectInvalid(["router:", "  default:", "    chain: []"].join("\n"));
    expect(err.message).toContain("router.default.chain");
  });

  it("rejects a scalar (non-mapping) document", async () => {
    const err = await loadExpectInvalid("just a string\n");
    expect(err.message).toContain("nyx.config.yaml");
    expect(err.message).toContain("(root)");
  });

  it("reports the YAML line on a syntax error", async () => {
    // Unclosed flow mapping: the parser reports the EOF position, line 2.
    const err = await loadExpectInvalid('server: { host: "127.0.0.1", port: 8787\n');
    expect(err.message).toContain("nyx.config.yaml");
    expect(err.message).toContain("YAML syntax error");
    expect(err.message).toContain("line 2");
  });

  it("wraps an unreadable file in ConfigError naming the path", async () => {
    const missing = join(tmpdir(), "nyx-config-test-does-not-exist", "nyx.config.yaml");
    let err: unknown;
    try {
      await loadConfig(missing);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain(missing);
  });

  it("uses the default path ./nyx.config.yaml when none is given", async () => {
    let err: unknown;
    try {
      await loadConfig();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain("./nyx.config.yaml");
  });
});

describe("loadConfig — env interpolation", () => {
  const ENV_CONFIG = [
    "server:",
    "  auth:",
    "    owner_token: ${TEST_OWNER_TOKEN}",
    "providers:",
    "  local:",
    "    kind: openai",
    '    base_url: "http://${TEST_HOST}:8080/v1"',
    "    models:",
    "      - id: m",
    "        context_window: 8",
    "        max_output: 4",
    "router:",
    "  default:",
    "    chain:",
    "      - provider: local",
    "        model: m",
  ].join("\n");

  it("resolves whole-string and embedded refs", async () => {
    const file = await tempConfig(ENV_CONFIG);
    const cfg = await loadConfig(file, {
      env: { TEST_OWNER_TOKEN: "tok-1", TEST_HOST: "llama" },
    });
    expect(cfg.server?.auth.owner_token).toBe("tok-1");
    expect(cfg.providers.local?.kind).toBe("openai");
    const local = cfg.providers.local;
    if (local?.kind !== "openai") throw new Error("expected openai provider");
    expect(local.base_url).toBe("http://llama:8080/v1");
  });

  it("fails on a missing var naming var, file, and field path", async () => {
    const file = await tempConfig(ENV_CONFIG);
    let err: unknown;
    try {
      await loadConfig(file, { env: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as ConfigError).message;
    expect(msg).toContain("TEST_OWNER_TOKEN");
    expect(msg).toContain(file);
    expect(msg).toContain("server.auth.owner_token");
  });

  it("treats an explicitly-undefined env entry as missing", async () => {
    const file = await tempConfig(ENV_CONFIG);
    await expect(
      loadConfig(file, { env: { TEST_OWNER_TOKEN: undefined, TEST_HOST: "h" } }),
    ).rejects.toThrow(/TEST_OWNER_TOKEN/);
  });

  it("uses process.env when opts.env is omitted", async () => {
    vi.stubEnv("TEST_OWNER_TOKEN", "from-process-env");
    vi.stubEnv("TEST_HOST", "proc-host");
    const file = await tempConfig(ENV_CONFIG);
    const cfg = await loadConfig(file);
    expect(cfg.server?.auth.owner_token).toBe("from-process-env");
  });

  it("opts.env overrides process.env", async () => {
    vi.stubEnv("TEST_OWNER_TOKEN", "from-process-env");
    vi.stubEnv("TEST_HOST", "proc-host");
    const file = await tempConfig(ENV_CONFIG);
    const cfg = await loadConfig(file, {
      env: { TEST_OWNER_TOKEN: "from-opts", TEST_HOST: "opts-host" },
    });
    expect(cfg.server?.auth.owner_token).toBe("from-opts");
    const local = cfg.providers.local;
    if (local?.kind !== "openai") throw new Error("expected openai provider");
    expect(local.base_url).toBe("http://opts-host:8080/v1");
  });

  it("opts.env fully replaces process.env (hermetic)", async () => {
    vi.stubEnv("TEST_OWNER_TOKEN", "from-process-env");
    const file = await tempConfig(ENV_CONFIG);
    // TEST_OWNER_TOKEN exists in process.env but not in the provided env.
    await expect(loadConfig(file, { env: { TEST_HOST: "h" } })).rejects.toThrow(/TEST_OWNER_TOKEN/);
  });

  it("keeps env-resolved values out of validation error messages", async () => {
    const file = await tempConfig(["logging:", "  level: ${SECRET_LEVEL}", ROUTER].join("\n"));
    let err: unknown;
    try {
      await loadConfig(file, { env: { SECRET_LEVEL: "super-secret-choice" } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as ConfigError).message;
    expect(msg).toContain("logging.level");
    expect(msg).not.toContain("super-secret-choice");
  });
});

describe("loadConfig — example config", () => {
  it("parses ../../..(/)nyx.config.example.yaml with the referenced env vars", async () => {
    const cfg = await loadConfig(EXAMPLE_CONFIG, {
      env: {
        NYX_OWNER_TOKEN: "stub-owner-token",
        NYX_ZAI_API_KEY: "stub-zai-key",
        NYX_OPENAI_API_KEY: "stub-openai-key",
        NYX_ANTHROPIC_API_KEY: "stub-anthropic-key",
      },
    });

    // Router: zai first, local fallback; compaction routed to a low-effort chain.
    expect(cfg.router.default.chain.map((s) => s.provider)).toEqual(["zai", "local"]);
    expect(cfg.router.rules[0]?.match.task).toBe("compaction");
    expect(cfg.router.rules[0]?.chain[0]?.reasoning_effort).toBe("low");

    // The default policy ruleset: allow R0/R1, ask R2–R4.
    expect(cfg.policy.rules.map((r) => r.id)).toEqual([
      "allow-r0",
      "allow-r1",
      "ask-r2",
      "ask-r3",
      "ask-r4",
    ]);
    expect(cfg.policy.rules.map((r) => r.decision)).toEqual([
      "allow",
      "allow",
      "ask",
      "ask",
      "ask",
    ]);

    // All documented local + hosted providers are present.
    expect(Object.keys(cfg.providers)).toEqual([
      "mock",
      "local",
      "lmstudio",
      "vllm",
      "zai",
      "openai",
      "anthropic",
    ]);
    const local = cfg.providers.local;
    if (local?.kind !== "openai") throw new Error("expected openai provider");
    expect(local.base_url).toBe("http://127.0.0.1:8080/v1");

    expect(cfg.sandbox.provider).toBe("docker");
    expect(cfg.sandbox.image).toBe("alpine:3.20");
    expect(cfg.server?.auth.owner_token).toBe("stub-owner-token");
    expect(cfg.owner_id).toBe("owner");
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});
