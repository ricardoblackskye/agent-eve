# Database Migrations

## Overview
PostgreSQL schema migration DDL scripts defining Dark Factory relational tables, indexes, tenant attribution columns, and row-level security policies.

## Interface
- `[001_df_cost_budgets.sql:df_cost_budgets]` - Table storing cost budget caps and expenditure accumulators per period and category
- `[001_df_cost_budgets.sql:df_cost_reservations]` - Table tracking active cost reservations referencing budget rows
- `[002_df_usage_ledger.sql:df_usage_events]` - Table logging append-only LLM usage and token/cost metrics
- `[003_df_tenants.sql:df_tenants]` - Table storing opaque tenant IDs, unique slugs, and customer tenant status
- `[003_df_tenants.sql:df_tenant_repos]` - Table mapping repository slugs 1:1 to tenant IDs
- `[004_df_usage_tenant.sql:df_usage_events]` - Column addition for nullable tenant_id attribution on usage events
- `[005_df_run_tenant.sql:df_run_summaries]` - Column addition and partial index for immutable tenant_id attribution on runs
- `[006_df_rls_coverage.sql]` - Row Level Security (RLS) enablement for df_run_summaries, df_run_events, df_run_deliveries, df_run_control_receipts, df_factory_control, df_run_control, df_control_events, and dark_factory_state
- `[007_df_cost_budgets_tenant.sql:df_cost_budgets]` - Column addition and composite index for tenant_id dimension on cost budgets
- `[008_df_tenant_members.sql:df_tenant_members]` - Table storing user email to tenant and role memberships with RLS enabled
- `[009_df_amm_scans.sql:df_amm_scans]` - Row Level Security (RLS) enablement for Automated Maturity Model scan results

## Invariants
- [scripts/db-migrate.ts:FILENAME] Migration files must follow the strict 'NNN_name.sql' format with 3-digit numeric prefixes and snake_case names
- [scripts/db-migrate.ts:checksumOf] Normalized LF SHA-256 checksums are enforced; modified applied migrations fail closed with a checksum mismatch refusal
- [002_df_usage_ledger.sql:tokens_in] Unmeasured metrics are stored as NULL and must never default to zero
- [003_df_tenants.sql:id] Tenant identifiers are opaque UUIDs decoupled from mutable names or repository slugs
- [004_df_usage_tenant.sql:tenant_id] Tenant attribution on usage and run records is write-once and nullable (NULL denotes unassigned historical runs)
- [006_df_rls_coverage.sql:ENABLE ROW LEVEL SECURITY] All Dark Factory tables must enable Row Level Security with no public access policies

## Side Effects
- Executes DDL statements against the PostgreSQL database (table creation, column alteration, index creation, RLS enablement)
- Recorded in public.schema_migrations table during execution by scripts/db-migrate.ts

## Verification
- Run: `npm test`
