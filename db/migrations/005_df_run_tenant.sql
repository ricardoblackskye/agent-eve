-- Dark Factory R1 — immutable tenant attribution on runs (#213, epic #212)
-- Provider-neutral PostgreSQL (Supabase). Standard SQL only; no vendor SDK.
--
-- `tenant_id` is NULLABLE ON PURPOSE. NULL means UNASSIGNED — a genuine state
-- for runs recorded before attribution existed. It is NOT a default, and
-- reporting must render it as "unassigned" rather than folding it into a
-- tenant's totals.
--
-- WRITE-ONCE: resolved from the repository mapping when a delivery is accepted.
-- The store's lifecycle UPDATE deliberately omits this column, so a later
-- event — or reassigning the repository — can never rewrite a run's stored
-- attribution.

ALTER TABLE df_run_summaries ADD COLUMN IF NOT EXISTS tenant_id TEXT;

-- Partial index: the reporting query filters to attributed runs, so unassigned
-- rows (which may be the majority on a long-lived deployment) stay out of it.
CREATE INDEX IF NOT EXISTS df_run_summaries_tenant_idx
  ON df_run_summaries (tenant_id, created_at DESC, run_id DESC)
  WHERE tenant_id IS NOT NULL;