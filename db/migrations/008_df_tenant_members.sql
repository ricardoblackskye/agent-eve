-- Dark Factory R3 — customer membership (#215, epic #212)
-- Provider-neutral PostgreSQL (Supabase). Standard SQL only; no vendor SDK.
--
-- A membership binds a signed-in email to a role and, for a customer, to one
-- tenant. It is the ONLY source of tenant scope: the session cookie carries an
-- email and nothing else, so a revocation takes effect on the next request.
--
-- RLS is enabled with no public policies: access is server-side only, and there
-- is no browser-to-Postgres path. A server-side role (service role / table owner)
-- still bypasses RLS. The runtime adapter also creates this table on first use;
-- this migration is the source-controlled shape for an existing database.

CREATE TABLE IF NOT EXISTS df_tenant_members (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  tenant_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS df_tenant_members_tenant_idx
  ON df_tenant_members (tenant_id);

ALTER TABLE IF EXISTS df_tenant_members ENABLE ROW LEVEL SECURITY;