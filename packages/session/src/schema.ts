// SPDX-License-Identifier: AGPL-3.0-or-later
// Drizzle-orm table definitions for the session-store schema. The authoritative
// DDL lives in ../drizzle/0000_init.sql (handwritten migrations); these
// definitions mirror it column-for-column so drizzle queries are typed
// against the real tables. Hot paths (append/read) use raw prepared
// statements instead — see store.ts.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  parentId: text("parent_id"),
  ownerId: text("owner_id").notNull(),
  personaId: text("persona_id").notNull(),
  title: text("title").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  engagementJson: text("engagement_json"),
  metadataJson: text("metadata_json"),
});

export const events = sqliteTable("events", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  ts: integer("ts").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  turnId: text("turn_id").notNull(),
  seq: integer("seq").notNull(),
  role: text("role").notNull(),
  contentJson: text("content_json").notNull(),
  ts: integer("ts").notNull(),
});

export const toolCalls = sqliteTable("tool_calls", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  turnId: text("turn_id").notNull(),
  seq: integer("seq").notNull(),
  name: text("name").notNull(),
  inputJson: text("input_json").notNull(),
  outputJson: text("output_json"),
  status: text("status").notNull(),
  ts: integer("ts").notNull(),
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  turnId: text("turn_id").notNull(),
  actionDigest: text("action_digest").notNull(),
  summary: text("summary").notNull(),
  risk: text("risk").notNull(),
  decision: text("decision").notNull().default("pending"),
  decidedBy: text("decided_by"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  tagsJson: text("tags_json").notNull(),
  sourceJson: text("source_json").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  sessionId: text("session_id"),
  state: text("state").notNull(),
  specJson: text("spec_json").notNull(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at"),
  attempts: integer("attempts").notNull().default(0),
  resultJson: text("result_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const audit = sqliteTable("audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const personas = sqliteTable("personas", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  configJson: text("config_json").notNull(),
  soulMd: text("soul_md").notNull(),
  contractMd: text("contract_md").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const models = sqliteTable("models", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  capabilitiesJson: text("capabilities_json").notNull(),
  contextWindow: integer("context_window").notNull(),
  enabled: integer("enabled").notNull().default(1),
});

export const projectionVersion = sqliteTable("projection_version", {
  name: text("name").primaryKey(),
  lastSeq: integer("last_seq").notNull(),
});
