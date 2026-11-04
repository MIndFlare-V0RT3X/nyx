-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0002_tasks_v2 (Phase 4 §2.1): the durable-task substrate.
--
-- The Phase 0 `tasks` table existed in the DDL but was never written by any
-- code (see 0000's header comment); this migration rebuilds it with the
-- Phase 4 shape. The rebuild is a CREATE-SELECT-DROP-RENAME inside the
-- migration runner's single transaction: an empty (or legacy) table comes
-- out with the new columns, the CHECK constraint on state, and the indexes
-- the worker's claim path needs. Nothing else in nyx.db is touched — the
-- audit chain, sessions, and events are not weakened by this migration.
--
-- Columns:
--   session_id           — the parent session the task is bound to (nullable)
--   task_session_id      — the task's OWN session (its metadata log; the
--                          task's subagents hang off this lineage)
--   spec_json            — the full TaskSpec (canonical JSON)
--   lease_owner          — worker id holding the lease (null when unleased)
--   lease_expires_at     — epoch ms; a running row with an expired lease is
--                          reclaimable by any worker
--   attempts             — attempts consumed so far (reset by retry())
--   subagent_session_id  — the CURRENT attempt's child session; always a
--                          real session once set (no orphans)
--   last_error_json      — the most recent attempt's serialized error
--   result_json          — the SubagentResult of a completed attempt
--   next_attempt_at      — earliest epoch ms the next attempt may run
--                          (retry backoff / cron reset)

CREATE TABLE IF NOT EXISTS tasks_v2 (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  task_session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','running','paused','completed','failed','cancelled')),
  spec_json TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  subagent_session_id TEXT,
  last_error_json TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_attempt_at INTEGER
);
INSERT INTO tasks_v2 (id, session_id, task_session_id, state, spec_json, lease_owner, lease_expires_at,
                      attempts, subagent_session_id, last_error_json, result_json,
                      created_at, updated_at, next_attempt_at)
  SELECT id, session_id, NULL, state, spec_json, lease_owner, lease_expires_at,
         attempts, NULL, NULL, result_json, created_at, updated_at, NULL
    FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_v2 RENAME TO tasks;
CREATE INDEX IF NOT EXISTS idx_tasks_state_due ON tasks(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
