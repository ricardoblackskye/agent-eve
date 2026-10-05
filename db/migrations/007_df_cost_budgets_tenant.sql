-- Dark Factory R2 — tenant dimension on cost budgets (#229, epic #212)
-- Provider-neutral PostgreSQL (Supabase). Standard SQL only; no vendor SDK.
--
-- A tenant budget and the global budget are DISTINCT rows and are never merged:
-- `tenant_id IS NULL` is the global budget the operator panel reads, and a set
-- `tenant_id` is one customer's operator-provisioned cap.
--
-- The runtime adapter already creates this column for fresh databases
-- (`cost-budget-store-postgres.ts` `ensureSchema`); this migration brings an
-- existing database up to the same shape. `budget_id` already encodes the
-- tenant, so no primary-key change is needed.

ALTER TABLE IF EXISTS df_cost_budgets ADD COLUMN IF NOT EXISTS tenant_id TEXT;

CREATE INDEX IF NOT EXISTS df_cost_budgets_tenant_idx
  ON df_cost_budgets (tenant_id, period, category);