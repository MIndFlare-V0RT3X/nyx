// SPDX-License-Identifier: AGPL-3.0-or-later
// The Zod schema for nyx.config.yaml. One source of truth for the config
// shape: defaults, enums, strictness (typos must not silently pass), and the
// PolicyRule / ModelInfo mirrors of the frozen @nyx/protocol types.
//
// Invariants enforced here:
// - The top level (and every nested object) is strict: unknown keys are
//   rejected with the offending key in the field path.
// - `router` is the only required top-level section: a model route is the one
//   thing NYX cannot invent a default for. Everything else has a default.
// - `server` is optional (a config may describe a headless/tooling setup), but
//   when present its auth.owner_token is required.
// - "~"-prefixed filesystem roots are expanded to os.homedir() at parse time.

import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ModelInfo, PolicyRule } from "@nyx/protocol";

// ---------------------------------------------------------------------------
// Mirrors of protocol enums (protocol exports types, not config schemas).
// The probes at the bottom of this file fail the build if these drift.
// ---------------------------------------------------------------------------

const riskTierSchema = z.enum(["R0", "R1", "R2", "R3", "R4"]);

const capabilitySchema = z.enum([
  "fs.read",
  "fs.write",
  "fs.delete",
  "proc.spawn",
  "proc.kill",
  "net.egress",
  "net.listen",
  "browser.control",
  "desktop.control",
  "credential.use",
  "host.access",
  "git.push",
  "deploy",
]);

const decisionSchema = z.enum(["allow", "ask", "deny"]);

const modelCapabilitySchema = z.enum([
  "tools",
  "vision",
  "reasoning",
  "reasoning_retained",
  "json_schema",
  "streaming_tools",
]);

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const modelInfoSchema = z
  .object({
    id: z.string().min(1),
    context_window: z.number().int().positive(),
    max_output: z.number().int().positive(),
    supports: z.array(modelCapabilitySchema).default([]),
  })
  .strict();

const providerSchema = z.discriminatedUnion("kind", [
  // Deterministic test double; takes no other fields.
  z.object({ kind: z.literal("mock") }).strict(),
  // Any OpenAI-compatible endpoint: llama.cpp, LM Studio, vLLM, Ollama, and
  // hosted OpenAI-style APIs. Local servers usually need no api_key_env.
  z
    .object({
      kind: z.literal("openai"),
      base_url: z.string().url(),
      api_key_env: z.string().min(1).optional(),
      models: z.array(modelInfoSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("anthropic"),
      // Optional: proxies exist, but the official endpoint needs no override.
      base_url: z.string().url().optional(),
      api_key_env: z.string().min(1),
      models: z.array(modelInfoSchema),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const fallbackReasonSchema = z.enum(["rate_limit", "server_error", "timeout"]);

const chainStepSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoning_effort: z.enum(["low", "high", "max"]).optional(),
    max_tokens: z.number().int().positive().optional(),
    tool_choice: z.enum(["auto", "none"]).optional(),
  })
  .strict();

export const chainSchema = z.array(chainStepSchema).min(1, "chain must contain at least one step");

const routeRuleSchema = z
  .object({
    match: z.object({ task: z.string().min(1) }).strict(),
    chain: chainSchema,
  })
  .strict();

const budgetsSchema = z
  .object({
    per_turn_tokens: z.number().int().positive().default(200_000),
    per_session_tokens: z.number().int().positive().default(5_000_000),
    on_exceed: z.enum(["ask", "trim", "abort"]).default("ask"),
  })
  .strict();

const routerSchema = z
  .object({
    default: z
      .object({
        chain: chainSchema,
        fallback_on: z
          .array(fallbackReasonSchema)
          .default(["rate_limit", "server_error", "timeout"]),
      })
      .strict(),
    rules: z.array(routeRuleSchema).default([]),
    budgets: budgetsSchema.default({}),
  })
  .strict();

// ---------------------------------------------------------------------------
// Policy (mirror of @nyx/protocol PolicyRule — field names identical)
// ---------------------------------------------------------------------------

const policyMatchSchema = z
  .object({
    tool: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
    capability: z.union([capabilitySchema, z.array(capabilitySchema)]).optional(),
    risk: z.union([riskTierSchema, z.array(riskTierSchema)]).optional(),
    path_prefix: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    owner_only: z.boolean().optional(),
  })
  .strict();

const policyRuleSchema = z
  .object({
    id: z.string().min(1),
    match: policyMatchSchema,
    decision: decisionSchema,
    reason: z.string().optional(),
    immutable: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const tokensSchema = z.record(z.string().min(1), z.string().min(1)).superRefine((tokens, ctx) => {
  if ("owner" in tokens) {
    // The owner identity is fixed by owner_id; it cannot be shadowed here.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["owner"],
      message: 'actor name "owner" is reserved (the owner authenticates via owner_token)',
    });
  }
});

const serverSchema = z
  .object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535).default(8787),
    auth: z
      .object({
        owner_token: z.string().min(1),
        tokens: tokensSchema.default({}),
      })
      .strict(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Filesystem-rooted sections (~ expansion happens here, at parse time)
// ---------------------------------------------------------------------------

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** 2.0.3: IANA timezone validation without importing @nyx/runtime. */
function isValidIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const tildePathSchema = z.string().min(1).transform(expandTilde);

const sandboxSchema = z
  .object({
    provider: z.enum(["docker", "local"]).default("docker"),
    image: z.string().min(1).default("alpine:3.20"),
    workdir_root: tildePathSchema.default("~/.nyx/sandboxes"),
  })
  .strict();

const memorySchema = z
  .object({
    root: tildePathSchema.default("~/.nyx/memory"),
    episode_expiry_days: z.number().int().positive().default(30),
  })
  .strict();

const personaSchema = z
  .object({
    default_id: z.string().min(1).default("default"),
    root: z.string().min(1).default("./personas"),
  })
  .strict();

const loggingSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    redact: z.array(z.string().min(1)).default(["api_key", "authorization", "token", "secret"]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

export const configSchema = z
  .object({
    // Optional: a config may describe a headless/tooling deployment. When
    // present, auth.owner_token is required.
    server: serverSchema.optional(),
    providers: z.record(z.string().min(1), providerSchema).default({}),
    // The only required section: NYX cannot invent a default model route.
    router: routerSchema,
    policy: z
      .object({ rules: z.array(policyRuleSchema).default([]) })
      .strict()
      .default({}),
    sandbox: sandboxSchema.default({}),
    memory: memorySchema.default({}),
    persona: personaSchema.default({}),
    logging: loggingSchema.default({}),
    // Optional (Phase 1): per-session lane queue tuning. Absent → code
    // defaults (4 global, 1 per session, heartbeats serialized).
    lanes: z
      .object({
        max_concurrent_global: z.number().int().min(1).max(256),
        max_concurrent_per_session: z.number().int().min(1).max(64),
        heartbeat_serialized_with_interactive: z.boolean(),
      })
      .strict()
      .optional(),
    // Optional (Phase 1): channel ingress. Disabled by default — an operator
    // must opt in per adapter.
    channels: z
      .object({
        webhook: z
          .object({
            enabled: z.boolean(),
            path: z.string().min(1).startsWith("/"),
            bind: z.string().min(1),
            port: z.number().int().min(0).max(65535),
            allowed_owners: z.array(z.string().min(1)),
            reply_timeout_ms: z.number().int().min(1),
            approval_ttl_ms: z.number().int().min(1_000).optional(),
          })
          .strict()
          .optional(),
        telegram: z
          .object({
            enabled: z.boolean(),
            bot_token_env: z.string().min(1),
            allowed_user_ids: z.array(z.number().int()),
            poll_timeout_s: z.number().int().min(1).max(120),
            edit_interval_ms: z.number().int().min(500),
            approval_ttl_ms: z.number().int().min(1_000).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    // Optional (Phase 1): heartbeat / cron — scheduled system turns. Disabled
    // unless opted in; specs default to none. 2.0.3: each spec may name an
    // IANA timezone the cron expression is interpreted in (default UTC).
    heartbeat: z
      .object({
        enabled: z.boolean(),
        specs: z
          .array(
            z
              .object({
                id: z.string().min(1),
                schedule: z.string().min(1),
                timezone: z
                  .string()
                  .min(1)
                  .refine(isValidIanaTimeZone, {
                    message: "timezone must be a valid IANA timezone name",
                  })
                  .optional(),
                persona_id: z.string().min(1).optional(),
                session_id: z.string().min(1).optional(),
                prompt: z.string().min(1),
                priority: z.literal("heartbeat"),
                enabled: z.boolean(),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .optional(),
    // Optional (Phase 3): the subagent system. Absent → code defaults
    // (documented in docs/SUBAGENTS.md). max_depth 0 disables spawning
    // entirely — the spawn_subagent tool is then never registered.
    subagents: z
      .object({
        max_depth: z.number().int().min(0).max(10).default(3),
        max_total_per_turn: z.number().int().positive().default(200_000),
        default_budget_tokens: z.number().int().positive().default(32_768),
        max_budget_tokens: z.number().int().positive().default(65_536),
        default_allowed_tools: z
          .array(z.string().min(1))
          .default(["fs.read", "fs.write", "fs.list", "shell.exec", "web.fetch"]),
        forbidden_tools: z
          .array(z.string().min(1))
          .default(["spawn_subagent", "spawn_subagent_v2"]),
        // Phase 4 §4: fork is the DEFAULT — no implicit filesystem sharing between
        // parent and child; artifacts are the explicit, hash-audited handoff.
        sandbox_sharing: z.enum(["inherit", "fork"]).default("fork"),
        // Phase 4 GC knobs (retention durable task); see docs/RETENTION.md.
        // The task itself SHIPS DISABLED: retention_enabled must be set true
        // before the surface creates `nyx:retention-gc` — moving user data
        // to the archive database on first boot would otherwise surprise.
        retention_enabled: z.boolean().default(false),
        retention_days: z.number().int().min(0).default(7),
        retention_scope: z
          .enum(["subagent", "subagent+failed", "all", "none"])
          .default("subagent"),
        delete_after_days: z.number().int().min(0).default(0),
        retention_schedule: z.string().min(1).default("30 3 * * *"),
      })
      .strict()
      .default({}),
    // Optional (Phase 4 §2.1): the durable-task worker pool. Absent → code
    // defaults (documented in docs/TASKS.md).
    tasks: z
      .object({
        enabled: z.boolean().default(true),
        workers: z.number().int().min(1).max(16).default(2),
        poll_interval_ms: z.number().int().min(50).default(500),
        lease_ttl_ms: z.number().int().min(1_000).default(300_000),
        renew_interval_ms: z.number().int().min(500).default(30_000),
      })
      .strict()
      // Fan-out review R1-5, load-time mirror of the worker-pool guard: a
      // renewal cadence at or beyond the lease TTL opens a recurring window
      // where the lease is expired-but-unreclaimed while the owner is
      // mid-attempt — any competitor reclaims and the task double-executes
      // live. Reject at config load, not at first pool start.
      .superRefine((tasks, ctx) => {
        if (tasks.renew_interval_ms >= tasks.lease_ttl_ms) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["renew_interval_ms"],
            message:
              `tasks.renew_interval_ms (${tasks.renew_interval_ms}) must be strictly less than ` +
              `tasks.lease_ttl_ms (${tasks.lease_ttl_ms})`,
          });
        }
      })
      .default({}),
    // Optional (Phase 4 §4.4): the progressive-disclosure skill system. The
    // persona's own skills/ dir joins the scan at runtime; dirs here are the
    // shared bases. See docs/SKILLS.md.
    skills: z
      .object({
        catalog_max_tokens: z.number().int().min(200).max(20_000).default(2000),
        dirs: z.array(z.string().min(1)).default(["~/.nyx/skills"]),
        pinned: z.array(z.string().min(1)).default([]),
        excluded: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({}),
    // Optional (Phase 5 §3): the security subsystem. Absent → code defaults.
    // The security TOOLS register when enabled (they are technique-gated to
    // absence without an authorizing engagement — enabling registration is
    // safe by construction). The skills themselves ship in skills/security/
    // and surface via skills.dirs. See docs/SECURITY-SUBSYSTEM.md.
    security: z
      .object({
        enabled: z.boolean().default(true),
        // Where the binaries execute. "sandbox" routes them through the
        // session sandbox (network-locked until the container egress ACL
        // roadmap lands — for offline/local processing); "host" runs
        // operator-installed binaries with the tool layer's checked egress.
        executor: z.enum(["sandbox", "host"]).default("sandbox"),
      })
      .strict()
      .default({}),
    // Optional (Phase 2 §2.2): the four-tier compaction pipeline. Absent →
    // code defaults (documented in docs/COMPACTION.md).
    context: z
      .object({
        compaction: z
          .object({
            elision_threshold_tokens: z.number().int().min(1).default(5000),
            session_memory_threshold: z.number().min(0.1).max(1).default(0.6),
            session_memory_min_turns: z.number().int().min(1).default(20),
            llm_summary_threshold: z.number().min(0.1).max(1).default(0.8),
            emergency_threshold: z.number().min(0.1).max(1).default(0.95),
            post_compaction_reread_tokens: z.number().int().min(1).default(5000),
            post_compaction_reread_files: z.number().int().min(1).default(5),
            enabled: z.boolean().default(true),
            verbose_events: z.boolean().default(false),
          })
          .strict()
          .default({}),
      })
      .strict()
      .optional(),
    owner_id: z.string().min(1).default("owner"),
  })
  .strict();

export type NyxConfig = z.infer<typeof configSchema>;
export type NyxServerConfig = z.infer<typeof serverSchema>;
export type NyxProviderConfig = z.infer<typeof providerSchema>;
export type NyxModelConfig = z.infer<typeof modelInfoSchema>;
export type NyxChainStep = z.infer<typeof chainStepSchema>;
export type NyxRouteRule = z.infer<typeof routeRuleSchema>;
export type NyxRouterConfig = z.infer<typeof routerSchema>;
export type NyxPolicyRuleConfig = z.infer<typeof policyRuleSchema>;
export type NyxLanesConfig = z.infer<typeof configSchema>["lanes"];
export type NyxChannelsConfig = z.infer<typeof configSchema>["channels"];
export type NyxHeartbeatConfig = z.infer<typeof configSchema>["heartbeat"];
export type NyxSkillsConfig = z.infer<typeof configSchema>["skills"];
export type NyxSecurityConfig = z.infer<typeof configSchema>["security"];

// ---------------------------------------------------------------------------
// Compile-time drift probes. If either of these errors, the Zod mirror above
// no longer matches the frozen @nyx/protocol contract — fix the mirror, never
// the protocol.
// ---------------------------------------------------------------------------

const _policyRuleMirrorProbe: PolicyRule = {} as z.infer<typeof policyRuleSchema>;
const _policyRuleMirrorProbeReverse: z.infer<typeof policyRuleSchema> = {} as PolicyRule;
const _modelInfoMirrorProbe: ModelInfo = {} as z.infer<typeof modelInfoSchema>;
const _modelInfoMirrorProbeReverse: z.infer<typeof modelInfoSchema> = {} as ModelInfo;

void _policyRuleMirrorProbe;
void _policyRuleMirrorProbeReverse;
void _modelInfoMirrorProbe;
void _modelInfoMirrorProbeReverse;
