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
