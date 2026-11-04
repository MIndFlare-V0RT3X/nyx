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

export const ScopeTargetsSchema = z.object({
  cidrs: z.array(z.string()),
  domains: z.array(z.string()),
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

export const EngagementSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  operator_id: z.string().min(1),
  authorized_at: z.number().int().positive(),
  expires_at: z.number().int().positive(),
  targets: ScopeTargetsSchema,
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
]);

export const StoredEventSchema = z.intersection(
  SessionEventSchema,
  z.object({ seq: z.number().int().nonnegative() }),
);
