-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0004_findings (Phase 5 §2.2): the findings database.
--
-- Findings live in the shared nyx.db, scoped to their engagement, indexed by
-- severity, target host, and status. Title/description are full-text indexed
-- via FTS5 (contentless-mirror pattern: the findings table is the truth, the
-- FTS index is kept in sync by triggers and can be rebuilt from it).
--
-- Evidence artifacts are NOT stored here: the rows carry their workspace
-- paths + sha256 hashes; the bytes stay in the engagement's artifacts/
-- directory (gitignored by default — the operator decides what to commit).

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  cvss_3_1 REAL,
  cvss_4_0 REAL,
  cwe_json TEXT,
  cve_json TEXT,
  target_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  reproduction TEXT NOT NULL,
  remediation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'confirmed', 'false_positive', 'duplicate')),
  discovered_at INTEGER NOT NULL,
  discovered_by TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS findings_engagement_severity_idx
  ON findings (engagement_id, severity);
CREATE INDEX IF NOT EXISTS findings_host_idx
  ON findings (json_extract(target_json, '$.host'));
CREATE INDEX IF NOT EXISTS findings_status_idx
  ON findings (status);

CREATE VIRTUAL TABLE IF NOT EXISTS findings_fts USING fts5(
  title, description,
  content='findings', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS findings_fts_ai AFTER INSERT ON findings BEGIN
  INSERT INTO findings_fts (rowid, title, description)
  VALUES (new.rowid, new.title, new.description);
END;

CREATE TRIGGER IF NOT EXISTS findings_fts_ad AFTER DELETE ON findings BEGIN
  INSERT INTO findings_fts (findings_fts, rowid, title, description)
  VALUES ('delete', old.rowid, old.title, old.description);
END;

CREATE TRIGGER IF NOT EXISTS findings_fts_au AFTER UPDATE ON findings BEGIN
  INSERT INTO findings_fts (findings_fts, rowid, title, description)
  VALUES ('delete', old.rowid, old.title, old.description);
  INSERT INTO findings_fts (rowid, title, description)
  VALUES (new.rowid, new.title, new.description);
END;
