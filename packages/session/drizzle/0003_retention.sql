-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0003_retention (Phase 4 §3): the retention-archive flag.
--
--   archived — 1 once the retention durable task (nyx:retention-gc) has
--              MOVED the session's event rows to the sibling archive
--              database (nyx-archive.db, ATTACHed as `archive`). The
--              sessions row itself stays in nyx.db (resolvable, listed only
--              with include_archived); session.read() serves the events
--              from the archive database. Distinct from Phase 3's
--              soft-archive (DELETE /v1/sessions/:id sets archived_at with
--              archived still 0 — events stay in nyx.db).
--   archived_at — set by BOTH archive paths; the retention pass keeps a
--              pre-existing value (COALESCE) so the original archive time
--              is never rewritten.
--
-- Idempotent-copy discipline: the retention pass copies events into the
-- archive BEFORE deleting them from nyx.db (INSERT OR REPLACE on the shared
-- primary key), so a crash at any point is safely re-runnable and never
-- loses an event.

ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_sessions_retention ON sessions(archived, kind, updated_at);
