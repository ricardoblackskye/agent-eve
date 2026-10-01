-- Dark Factory R1 — tenant attribution on the LLM usage ledger (#213, epic #212)
-- Provider-neutral PostgreSQL (Supabase). Standard SQL only; no vendor SDK.
--
-- `tenant_id` is NULLABLE ON PURPOSE. A NULL means the usage was never
-- attributed — a genuine state for rows written before the tenant registry
-- existed, and for runs whose repository has no assignment. Do not backfill a
-- guessed tenant and do not DEFAULT it: inventing an owner for historical spend
-- is worse than reporting it as unassigned.
--
-- The value is an opaque tenant id resolved server-side at run acceptance and
-- persisted immutably. It is never re-derived from today's repository mapping,
-- so reassigning a repository cannot rewrite historical attribution.
--
-- RLS-enabled with no public (anon/auth) policies: the operator API owns access
-- and the connection stays server-side.

ALTER TABLE df_usage_events
  ADD COLUMN IF NOT EXISTS tenant_id TEXT;

CREATE INDEX IF NOT EXISTS df_usage_events_tenant_idx
  ON df_usage_events (tenant_id, ts);