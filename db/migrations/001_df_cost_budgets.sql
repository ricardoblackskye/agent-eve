-- Dark Factory R8 — cost budgets (per-token + per-cost-category), R1 operator governance
-- Provider-neutral, Supabase-friendly PostgreSQL. No vendor SDK required.
-- RLS-enabled; no public (anon/auth) policies — operator API owns access.

CREATE TABLE IF NOT EXISTS df_cost_budgets (
  budget_id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  category TEXT NOT NULL,
  cap_usd DOUBLE PRECISION NOT NULL,
  spent_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  reserved_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS df_cost_reservations (
  reservation_id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES df_cost_budgets(budget_id) ON DELETE CASCADE,
  estimated_usd DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL,
  settled BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS df_cost_budgets_period_category_idx
  ON df_cost_budgets (period, category);

ALTER TABLE df_cost_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE df_cost_reservations ENABLE ROW LEVEL SECURITY;
