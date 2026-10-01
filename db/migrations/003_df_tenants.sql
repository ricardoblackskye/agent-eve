-- Dark Factory R1 — customer tenant registry (#213, epic #212)
-- Provider-neutral PostgreSQL (Supabase). Standard SQL only; no vendor SDK.
--
-- The tenant id is OPAQUE and STABLE: it is never the slug and never a
-- repository name, so renaming either cannot break historical attribution.
-- A repository is assigned to exactly one tenant (PRIMARY KEY on repo_slug),
-- and reassigning it updates the MAPPING only — already-persisted run
-- attribution is never rewritten, because it is not derived from this table.
--
-- RLS-enabled with no public (anon/auth) policies: the operator API owns
-- access and the connection stays server-side. No browser client reaches these
-- tables directly.

CREATE TABLE IF NOT EXISTS df_tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS df_tenant_repos (
  repo_slug TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS df_tenant_repos_tenant_idx
  ON df_tenant_repos (tenant_id);

ALTER TABLE df_tenants ENABLE ROW LEVEL SECURITY;

ALTER TABLE df_tenant_repos ENABLE ROW LEVEL SECURITY;