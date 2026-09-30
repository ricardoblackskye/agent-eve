-- Dark Factory R7.3 — LLM usage ledger (#209)
-- Append-only per-call / per-task usage. Provider-neutral PostgreSQL (Supabase).
--
-- The nullable measurement columns ARE the "unmeasured is absent" rule (#158):
-- a NULL means the value was never observed, never that it was zero. Do not add
-- a DEFAULT 0 here — that would silently turn "not measured" into "measured 0"
-- and drag every aggregate toward a number nobody observed.
--
-- RLS-enabled with no public (anon/auth) policies: the operator API owns access
-- and the connection stays server-side.

CREATE TABLE IF NOT EXISTS df_usage_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  pbi_id INTEGER,
  task_type TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd DOUBLE PRECISION,
  duration_ms INTEGER,
  ts TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS df_usage_events_ts_idx
  ON df_usage_events (ts);

CREATE INDEX IF NOT EXISTS df_usage_events_model_idx
  ON df_usage_events (model, ts);

CREATE INDEX IF NOT EXISTS df_usage_events_run_idx
  ON df_usage_events (run_id, ts);

ALTER TABLE df_usage_events ENABLE ROW LEVEL SECURITY;