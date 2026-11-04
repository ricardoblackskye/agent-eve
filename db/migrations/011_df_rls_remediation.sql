-- Dark Factory — RLS remediation for the tables the Supabase linter flags as public
-- Provider-neutral PostgreSQL (Supabase). Standard SQL only; no vendor SDK.
--
-- WHY THIS EXISTS: the committed migrations already enable RLS on these tables
-- (001 cost budgets/reservations, 002 usage events, 009 amm scans, 010 plan
-- ledger), but the repository has no migration runner. The application creates
-- the tables at runtime via ensureSchema, and the docs say the migrations "must
-- be run" against the hosted database. On an instance where they were never
-- applied, the tables exist without RLS and the linter reports them as public.
--
-- This migration is idempotent and safe to run whether or not the earlier
-- migrations were applied. It also fixes df_plan_estimate_accuracy, which the
-- linter reports as SECURITY DEFINER: a PostgreSQL view runs with the view
-- owner's permissions unless security_invoker is set, so the querying user's RLS
-- is not enforced.
--
-- POSTURE: RLS enabled with NO public policies. The operator API owns access and
-- the connection stays server-side; a server-side role (service role / table
-- owner) still bypasses RLS. A browser client reaching these tables directly
-- reads zero rows, which is the intent.
--
-- BEFORE RUNNING: confirm the application's connection role. If it connects as
-- `authenticated` or `anon` rather than service_role/owner, enabling RLS with no
-- policies will return zero rows to the app. Check with: SELECT current_user;

-- 1. The six tables the linter flagged as public without RLS.
ALTER TABLE IF EXISTS public.df_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_cost_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_cost_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_plan_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_amm_scans ENABLE ROW LEVEL SECURITY;

-- 2. The remaining Dark Factory tables already covered by earlier migrations.
--    Repeating them here closes the whole family in one run, so a remediation
--    leaves no gaps behind and does not depend on 001/002/009/010 having run.
ALTER TABLE IF EXISTS public.df_run_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_run_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_run_control_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_factory_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_run_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_control_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.dark_factory_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_tenant_repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.df_tenant_members ENABLE ROW LEVEL SECURITY;

-- 3. The view: enforce the querying user's permissions and RLS on the base
--    tables rather than the view owner's. Guarded because the view is created by
--    the adapter's runtime DDL and may not exist on a fresh database.
DO $$
BEGIN
  IF to_regclass('public.df_plan_estimate_accuracy') IS NOT NULL THEN
    EXECUTE 'ALTER VIEW public.df_plan_estimate_accuracy SET (security_invoker = true)';
  END IF;
END $$;

-- Verification (read-only; safe to run after the migration):
--
--   -- Tables in public still without RLS:
--   SELECT c.relname
--   FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public'
--     AND c.relkind = 'r'
--     AND NOT c.relrowsecurity
--     AND c.relname LIKE 'df\_%' ESCAPE '\';
--
--   -- Views in public without security_invoker:
--   SELECT c.relname, c.reloptions
--   FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public'
--     AND c.relkind = 'v'
--     AND (c.reloptions IS NULL
--          OR NOT ('security_invoker=true' = ANY(c.reloptions)));
