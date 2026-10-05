# #215 — Dark Factory tenant-scoped customer access (Epic #212, Release 3 of 3)

- Epic: [#212](https://github.com/ricardoblackskye/agent-eve/issues/212) — Customer Use Tracking
- Release issue: [#215](https://github.com/ricardoblackskye/agent-eve/issues/215) — **R3 of 3**
- Branch: `feat/df-tenant-access-212c`
- Delivery: one release PR closing #215. **#212 closes with it** — R3 is the last release.
- Dependencies: R1 (#213) attribution and R2 (#214) budgets are merged; #211 migration/RLS
  foundation is in place.

## Goal

Let customer users into the shared Eve instance while ensuring they can see only their own
repositories, runs, usage and budget status. Scope is resolved and enforced **server-side on
every request**, never from a caller-supplied tenant id.

## What exists today (reconnaissance)

| Seam                                              | Today                                                                          | R3 needs                                                            |
|---------------------------------------------------|--------------------------------------------------------------------------------|---------------------------------------------------------------------|
| Session (`app/auth-session.ts`)                   | `eve_session` HS256 JWT carrying `{email, iat, exp}` only — no role, no tenant | resolve role + tenant per request from the DB, never from the claim |
| Auth gate (`app/api/dark-factory/viewer-auth.ts`) | any valid session is a full operator                                           | role-aware: operator vs customer, fail-closed                       |
| Tenant model (`agent/lib/dark-factory/tenant.ts`) | `Tenant` + `df_tenants`, `df_tenant_repos` (repo to tenant)                    | unchanged                                                           |
| Membership                                        | **does not exist**                                                             | new `df_tenant_members` + a store seam                              |
| Run summaries (`run-history.ts`)                  | carry `tenantId` (write-once, R1)                                              | filter by it                                                        |
| Run list (`run-query.ts` `RunListParams`)         | `repo`/`issue`/status/time — **no tenant filter**                              | add a resolved-tenant filter                                        |
| Usage and budgets                                 | tenant-scoped rows exist (R1, R2)                                              | scope reads to the resolved tenant                                  |
| Routes                                            | unscoped; `?tenantId=` and `?repo=` are caller-supplied                        | ignore the caller tenant; scope from membership                     |
| RLS                                               | enabled with no policies; the server-side owner bypasses it                    | unchanged — still no browser to Postgres access                     |

## Decisions

1. **Membership is operator-managed and DB-backed.** Customers do not self-provision, and
   cannot edit budgets or repository assignments in this release.
2. **Scope is resolved server-side on every request** from the session email. Revocation and
   role changes take effect on the next request — no stale claim to wait out.
3. **Tenant scope comes from membership, never from the caller.** A supplied `tenantId` or
   `repo` is a filter *within* scope, never a way to widen it.
4. **Enforcement lives in the query and store layer**, not only in the UI.
5. **Roles:** `operator` (the existing dashboard plus administrative controls) and `customer`
   (read-only, own tenant).
6. **Fail-closed:** unauthenticated, unknown email, suspended or removed membership are denied.

## Legs (dependency order)

| Leg | Issue | Outcome                                                                                                                            | Proposed sub-branch (if split)           |
|-----|-------|------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------|
| 0   | #215  | Membership model and store seam plus `db/migrations/008_df_tenant_members.sql` with RLS                                            | `feat/df-tenant-access-212c0-membership` |
| 1   | #215  | `resolveViewer` — session email to `{role, tenantId}` per request, fail-closed                                                     | `feat/df-tenant-access-212c1-resolve`    |
| 2   | #215  | Tenant filter in the query layer: run list and events, usage, budgets                                                              | `feat/df-tenant-access-212c2-scope`      |
| 3   | #215  | Route enforcement: cross-tenant denied for tenant and repo filters, guessed run ids, event endpoints, tampered or replayed cursors | `feat/df-tenant-access-212c3-routes`     |
| 4   | #215  | Role capabilities: a customer cannot alter assignment, membership or budget                                                        | `feat/df-tenant-access-212c4-roles`      |
| 5   | #215  | Customer and operator UI, with empty, loading and error states and responsive tests, without cross-tenant leakage                  | `feat/df-tenant-access-212c5-ui`         |

## Release split — please choose

| Option              | Shape                                                                    | Branch                                                            | Trade-off                                         |
|---------------------|--------------------------------------------------------------------------|-------------------------------------------------------------------|---------------------------------------------------|
| **A (recommended)** | one PR, six legs, closing #215 and #212                                  | `feat/df-tenant-access-212c`                                      | matches R2: one review, one release; largest diff |
| B                   | two releases: legs 0 to 3 (enforcement), then legs 4 to 5 (roles and UI) | `feat/df-tenant-access-212c1`, then `feat/df-tenant-access-212c2` | smaller reviews; #212 stays open longer           |

## ADRs (part of this release's Definition of Done)

- **ADR 0016 — membership is resolved per request, not carried in the session claim.** Why
  revocation must not wait for a stale cookie, and why the claim holds only the email.
- **ADR 0017 — tenant scope is derived server-side and enforced in queries.** Why a
  caller-supplied tenant id is a filter, never a grant.

## Validation

- `npx vitest run` — full suite green with no regressions; every leg's RED watched failing first.
- `npx tsc --noEmit --incremental false` — clean.
- Local lint gate: cspell@9 over the changed files, markdown-table-formatter, prettier.
- Cross-tenant denial tests: a guessed run id, a foreign tenant filter, a foreign repo, a
  tampered cursor.
- Postgres integration in CI: membership and scoped reads against the disposable Postgres.

## Out of scope

Customer self-service onboarding, membership administration UI, budget editing, invoices, and
separate per-customer deployments.

## Open questions

1. Release split — option A or option B?
2. How is a customer's first membership created: an operator CLI script, a seed scenario, or
   both? (The issue says operator-managed; a script plus a local seed is the natural pair.)
3. Should the customer view be a separate route (`/dark-factory/me`) or the same page rendered
   read-only by role?