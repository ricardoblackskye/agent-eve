-- Dark Factory — RLS coverage for the plan ledger tables (#486)
-- Provider-neutral PostgreSQL (Supabase). Standard SQL only; no vendor SDK.
--
-- df_plans and df_plan_estimates are created by the adapter's runtime DDL
-- (CREATE TABLE IF NOT EXISTS on first use), not by a migration, so this
-- migration only ENABLES RLS. `IF EXISTS` keeps it safe to apply before the app
-- has created them.
--
-- Why these tables need it: an estimate row carries per-run and per-tenant cost
-- figures. Exposed to an anon or authenticated client it would leak commercial
-- pricing information about a customer's work.
--
-- RLS-enabled with no public (anon/auth) policies: the operator API owns access
-- and the connection stays server-side. No browser client reaches these tables
-- directly. A server-side role (service role / table owner) still bypasses RLS.

ALTER TABLE IF EXISTS df_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS df_plan_estimates ENABLE ROW LEVEL SECURITY;
