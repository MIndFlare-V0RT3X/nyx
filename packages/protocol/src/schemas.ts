// SPDX-License-Identifier: AGPL-3.0-or-later
// Zod schemas for every type that crosses a process boundary (event stream,
// HTTP API, IPC). Types live in their domain modules; these schemas are the
// wire truth. Keep both in sync by hand — schema drift is a bug.

import { z } from "zod";

export const RiskTierSchema = z.enum(["R0", "R1", "R2", "R3", "R4"]);
export const CapabilitySchema = z.enum([
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

export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative().optional(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
});

export const SerializedErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  code: z.string().optional(),
  stack: z.string().optional(),
  retryable: z.boolean().optional(),
});

export const ToolOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("json"), json: z.unknown() }),
  z.object({
    kind: z.literal("file"),
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    mime: z.string(),
  }),
  z.object({
    kind: z.literal("artifact"),
    artifact_id: z.string(),
    path: z.string(),
    bytes: z.number().int().nonnegative(),
  }),
]);

export const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), mime: z.string(), data_base64: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    call_id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({ type: z.literal("tool_result"), call_id: z.string(), output: ToolOutputSchema }),
  z.object({ type: z.literal("reasoning"), text: z.string(), encrypted: z.string().optional() }),
]);

export const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.array(ContentBlockSchema),
  name: z.string().optional(),
});

export const ToolCallSchema = z.object({
  call_id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

// ── Phase 3: subagent boundary schemas ──

export const SessionKindSchema = z.enum(["session", "fork", "subagent"]);

export const SubagentStateSchema = z.enum([
  "running",
  "completed",
  "failed",
  "aborted",
  "budget_exceeded",
]);

export const SubagentSpecSchema = z
  .object({
    task: z.string().min(1),
    tools: z.array(z.string().min(1)).optional(),
    model: z.string().min(1).optional(),
    budget_tokens: z.number().int().min(1024).optional(),
    max_depth_override: z.number().int().min(0).optional(),
  })
  .strict();

export const SubagentArtifactRefSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});

export const SubagentResultSchema = z.object({
  session_id: z.string(),
  summary: z.string(),
  state: z.enum(["completed", "failed", "aborted", "budget_exceeded"]),
  tokens_used: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  error: SerializedErrorSchema.optional(),
  // Phase 4 §4: the artifact handoff (fork mode). Optional — pre-Phase-4
  // serialized results carry no artifacts field.
  artifacts: z.array(SubagentArtifactRefSchema).optional(),
});

export const SubagentInfoSchema = z.object({
  session_id: z.string(),
  parent_session_id: z.string(),
  parent_turn_id: z.string(),
  spawned_at: z.number().int().nonnegative(),
  state: SubagentStateSchema,
  task: z.string(),
});

// ── Phase 4: durable task boundary schemas ──

export const TaskStateSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const TaskSpecSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(1),
    description: z.string().min(1),
    parent_session_id: z.string().min(1).optional(),
    subagent_spec: SubagentSpecSchema.omit({ task: true }),
    max_attempts: z.number().int().min(1).max(100).default(3),
    retry_backoff_ms: z.number().int().min(0).default(1000),
    timeout_ms: z.number().int().positive().optional(),
    priority: z.enum(["interactive", "background"]).default("background"),
    schedule: z.string().min(1).optional(),
  })
  .strict();

export const TaskRecordSchema = z.object({
  id: z.string(),
  task_session_id: z.string(),
  spec: TaskSpecSchema,
  state: TaskStateSchema,
  attempts: z.number().int().nonnegative(),
  lease_owner: z.string().nullable(),
  lease_expires_at: z.number().int().nonnegative().nullable(),
  subagent_session_id: z.string().nullable(),
  last_error: SerializedErrorSchema.nullable(),
  result: SubagentResultSchema.nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  next_attempt_at: z.number().int().nonnegative().nullable(),
});

export const ScopeTargetsSchema = z.object({
  cidrs: z.array(z.string()),
  domains: z.array(z.string()),
  urls: z.array(z.string()).optional(),
  ports: z
    .object({
      allow: z.array(z.number().int()).optional(),
      deny: z.array(z.number().int()).optional(),
    })
    .optional(),
  exclude: z
    .object({ cidrs: z.array(z.string()).optional(), domains: z.array(z.string()).optional() })
    .optional(),
});

export const EngagementTechniqueSchema = z.enum([
  "reconnaissance",
  "port_scanning",
  "web_enumeration",
  "vulnerability_scanning",
  "exploitation",
  "social_engineering",
]);

export const EngagementRateLimitSchema = z
  .object({
    requests_per_second: z.number().int().min(1).max(100_000).optional(),
    packets_per_second: z.number().int().min(1).max(10_000_000).optional(),
  })
  .strict();

export const EngagementSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  operator_id: z.string().min(1),
  authorized_at: z.number().int().positive(),
  starts_at: z.number().int().positive().optional(),
  expires_at: z.number().int().positive(),
  targets: ScopeTargetsSchema,
  techniques: z.array(EngagementTechniqueSchema).optional(),
  rate_limits: z.record(EngagementRateLimitSchema).optional(),
  client: z.string().min(1).optional(),
  authorized_by: z.string().min(1).optional(),
  emergency_contact: z.string().min(3).optional(),
  rules: z.array(z.string()).optional(),
});

const SessionRef = {
  session_id: z.string(),
  turn_id: z.string(),
  ts: z.number().int().nonnegative(),
};

export const SessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.created"),
    session_id: z.string(),
    owner_id: z.string(),
    persona_id: z.string(),
    parent_id: z.string().nullable(),
    engagement: EngagementSchema.nullable(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("turn.started"), ...SessionRef }),
  z.object({
    type: z.literal("message.user"),
    ...SessionRef,
    content: z.array(ContentBlockSchema),
  }),
  z.object({
    type: z.literal("message.assistant"),
    ...SessionRef,
    content: z.array(ContentBlockSchema),
  }),
  z.object({ type: z.literal("text.delta"), ...SessionRef, text: z.string() }),
  z.object({ type: z.literal("reasoning.delta"), ...SessionRef, text: z.string() }),
  z.object({
    type: z.literal("tool.call"),
    ...SessionRef,
    call_id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool.result"),
    ...SessionRef,
    call_id: z.string(),
    output: ToolOutputSchema,
  }),
  z.object({
    type: z.literal("tool.error"),
    ...SessionRef,
    call_id: z.string(),
    error: SerializedErrorSchema,
  }),
  z.object({
    type: z.literal("action.denied"),
    ...SessionRef,
    call_id: z.string(),
    reason: z.enum(["policy", "approval", "scope"]),
    detail: z.string(),
    rule_id: z.string().optional(),
  }),
  z.object({
    type: z.literal("approval.requested"),
    ...SessionRef,
    approval_id: z.string(),
    action_digest: z.string(),
    summary: z.string(),
    risk: RiskTierSchema,
  }),
  z.object({
    type: z.literal("approval.resolved"),
    ...SessionRef,
    approval_id: z.string(),
    decision: z.enum(["allow", "deny"]),
    decided_by: z.string(),
  }),
  z.object({
    type: z.literal("compaction.started"),
    ...SessionRef,
    strategy: z.enum(["rule-elision", "llm-summary", "session-memory", "emergency-degrade"]),
  }),
  z.object({
    type: z.literal("compaction.completed"),
    ...SessionRef,
    strategy: z.enum(["rule-elision", "llm-summary", "session-memory", "emergency-degrade"]),
    freed_tokens: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("turn.completed"), ...SessionRef, usage: UsageSchema }),
  z.object({ type: z.literal("turn.failed"), ...SessionRef, error: SerializedErrorSchema }),
  z.object({
    type: z.literal("session.forked"),
    session_id: z.string(),
    new_session_id: z.string(),
    at_seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("subagent.spawned"),
    session_id: z.string(),
    subagent_session_id: z.string(),
    turn_id: z.string(),
    parent_session_id: z.string(),
    parent_turn_id: z.string(),
    task: z.string(),
    depth: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("subagent.completed"),
    session_id: z.string(),
    subagent_session_id: z.string(),
    parent_session_id: z.string(),
    summary: z.string(),
    tokens_used: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("subagent.failed"),
    session_id: z.string(),
    subagent_session_id: z.string(),
    parent_session_id: z.string(),
    error: SerializedErrorSchema,
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("subagent.aborted"),
    session_id: z.string(),
    subagent_session_id: z.string(),
    parent_session_id: z.string(),
    reason: z.string(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("task.created"),
    session_id: z.string(),
    task_id: z.string(),
    title: z.string(),
    spec: TaskSpecSchema,
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("task.started"),
    session_id: z.string(),
    task_id: z.string(),
    attempt: z.number().int().positive(),
    subagent_session_id: z.string().nullable(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("task.completed"),
    session_id: z.string(),
    task_id: z.string(),
    result: SubagentResultSchema.nullable(),
    attempts: z.number().int().positive(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("task.failed"),
    session_id: z.string(),
    task_id: z.string(),
    error: SerializedErrorSchema,
    attempts: z.number().int().positive(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("task.paused"),
    session_id: z.string(),
    task_id: z.string(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("task.resumed"),
    session_id: z.string(),
    task_id: z.string(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("task.cancelled"),
    session_id: z.string(),
    task_id: z.string(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("task.retrying"),
    session_id: z.string(),
    task_id: z.string(),
    attempt: z.number().int().positive(),
    next_attempt_at: z.number().int().nonnegative(),
    error: SerializedErrorSchema,
    ts: z.number().int().nonnegative(),
  }),
  // Phase 4 §4.4 (recorded deviation, brief-mandated): progressive
  // disclosure on the record — a session loaded a skill body.
  z.object({
    type: z.literal("skill.loaded"),
    session_id: z.string(),
    name: z.string(),
    version: z.string().nullable(),
    ts: z.number().int().nonnegative(),
  }),
]);

export const StoredEventSchema = z.intersection(
  SessionEventSchema,
  z.object({ seq: z.number().int().nonnegative() }),
);
