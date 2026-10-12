# Plan — #325: wire the remaining 3 Postgres gate variables into CI

**Branch:** `ci/df-pg-gate-vars-325`
**Issue:** [#325](https://github.com/ricardoblackskye/agent-eve/issues/325)

## Context (corrected)

`ci.yml` **already** provisions a `postgres:16-alpine` service in the `test` job and already sets TWO
of the five gate variables. Three are missing, so **13 of the 24 Postgres tests silently SKIP in CI**
— the largest block being **`run-history` (9)**, the suite that would have caught #323.

| Gate variable | In CI | Tests |
|---|---|---|
| `DF_TENANT_TEST_DATABASE_URL` | yes (`ci.yml:57`) | 7 — run |
| `DF_COST_BUDGET_TEST_DATABASE_URL` | yes (`ci.yml:58`) | 4 — run |
| `DF_RUN_HISTORY_TEST_DATABASE_URL` | **missing** | 9 — skip |
| `DF_USAGE_TEST_DATABASE_URL` | **missing** | 3 — skip |
| `DF_CONTROL_DATABASE_URL` | **missing** | 1 — skip |

## Change

Add the three missing variables to the `test` job's EXISTING `env:` block, reusing the service that is
already there. No service, job or step changes.

## Why this is safe

- The DSN shape is already used by two variables in the same job.
- All five suites sharing ONE database is already exercised: my local run of all five against a single
  container passed **24/24** with parallel test files.
- `DF_CONTROL_DATABASE_URL` falls back to `DF_RUN_HISTORY_DATABASE_URL`, so setting it explicitly keeps
  the two meanings apart.

## Verification — the part that must be REAL

1. **CI-parity run.** Build a container to the WORKFLOW'S OWN spec
   (`POSTGRES_HOST_AUTH_METHOD=trust`, `POSTGRES_DB=darkfactory`) and run with the workflow's EXACT DSN
   strings (`postgres://postgres@localhost:5432/darkfactory?sslmode=disable`). Assert the 13
   previously-skipped tests now RUN and pass — not merely that the YAML looks right. The no-password
   URL and `sslmode=disable` differ from my earlier local run, so they must be exercised, not assumed.
2. YAML parses; changed-file gates (cspell / prettier / markdownlint) clean.
3. Count evidence: skipped drops to **2** (the LIVE network tests only).
4. **Non-vacuity**: the same command WITHOUT the three variables skips those 13 again.

## Out of scope

The service container (already exists) · the 2 LIVE network tests (need real GitHub access).
