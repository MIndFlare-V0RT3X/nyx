-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0001_sessions_kind (Phase 3): session lineage + archiving.
--   kind        — 'session' (default, every existing row), 'fork' (Phase 0
--                 fork mechanism children), 'subagent' (Phase 3 subagent
--                 children). Reuses parent_id for lineage in all cases.
--   archived_at — set by archiveSession() (DELETE /v1/sessions/:id on a
--                 subagent); archived sessions are hidden from list() but
--                 stay fully resolvable and replayable. Nothing is ever
--                 hard-deleted.

ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'session'
  CHECK (kind IN ('session', 'fork', 'subagent'));
ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
