-- Scorecard channels (Phase 2.6)
--
-- Adds two tables backing scorecard-type channels:
--   channel_scorecard_configs  — one JSON config per scorecard channel
--   channel_scorecard_actuals  — one row per (recruiter, month) actual
--
-- Note: this repo's production boot path applies schema changes via the
-- idempotent guarded runner in `server/migrate.ts` (see "v37"), which is
-- safe to run repeatedly. This drizzle-kit migration file is kept in sync
-- with that change for teams that run `drizzle-kit migrate` / `db:push`
-- directly against a fresh database. Same pattern as 0000_add_channels_title.

CREATE TABLE IF NOT EXISTS channel_scorecard_configs (
  channel_id INTEGER PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_by_user_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_scorecard_actuals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  recruiter_key TEXT NOT NULL,
  period_month TEXT NOT NULL,
  placements_count INTEGER NOT NULL DEFAULT 0,
  fee_amount_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  updated_by_user_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scorecard_actuals_unique
  ON channel_scorecard_actuals (channel_id, recruiter_key, period_month);
CREATE INDEX IF NOT EXISTS idx_scorecard_actuals_channel
  ON channel_scorecard_actuals (channel_id, period_month);
