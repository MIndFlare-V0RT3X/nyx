-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0005_rate_buckets (Phase 6.1, R1-10): cross-process GCRA bucket slots.
--
-- The Phase 5 rate limiter kept its buckets in process memory: two NYX
-- processes sharing nyx.db each enforced their own view and together ran
-- N× the declared rate. The egress proxy (docs/EGRESS-PROXY.md) charges
-- every CONNECT here instead — one row per (engagement, class, host) /
-- (engagement, host) bucket, reserved atomically by whichever kernel
-- process handles the connection.
--
-- `next_allowed_at` is the GCRA "when this bucket may next fire" slot
-- (Unix ms). Reservations commit immediately; callers sleep outside the
-- transaction. A crashed process leaves future-dated slots that self-heal
-- as wall-clock time passes. Stale rows are pruned lazily on reserve.

CREATE TABLE IF NOT EXISTS rate_buckets (
  key TEXT PRIMARY KEY,
  next_allowed_at INTEGER NOT NULL,
  interval_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_buckets_updated
  ON rate_buckets(updated_at);
