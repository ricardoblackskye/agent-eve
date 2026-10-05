-- Dark Factory R2 — RLS coverage for the run-history, control and state tables (#211)
-- Provider-neutral PostgreSQL (Supabase). Standard SQL only; no vendor SDK.
--
-- The Supabase database linter flagged public.df_run_summaries, df_run_events,
-- df_run_deliveries and df_run_control_receipts for missing row-level security.
-- The control and state tables below have the same gap.
--
-- These tables are created by the adapters' runtime DDL (`CREATE TABLE IF NOT
-- EXISTS` on first use), not by a migration, so this migration only ENABLES RLS.
-- `IF EXISTS` keeps it safe to apply before the app has created them.
--
-- RLS-enabled with no public (anon/auth) policies: the operator API owns access
-- and the connection stays server-side. No browser client reaches these tables
-- directly. A server-side role (service role / table owner) still bypasses RLS.

ALTER TABLE IF EXISTS df_run_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS df_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS df_run_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS df_run_control_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS df_factory_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS df_run_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS df_control_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS dark_factory_state ENABLE ROW LEVEL SECURITY;