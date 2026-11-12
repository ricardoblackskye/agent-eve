# Scripts

## Overview
Developer and operator CLI scripts, database migration runners, test data seeding harnesses, coverage ratchet gates, and OpenSandbox lifecycle automation tooling.

## Interface
- `coverage-ratchet.ts:compareCoverage(baseline, current, tolerance)` - Pure comparison of test coverage summary against baseline
- `coverage-ratchet.ts:runCoverageRatchet(argv, io, paths)` - CLI gate enforcing the coverage floor and updating coverage-baseline.json
- `db-migrate.ts:computePlan(files, applied)` - Pure plan generator comparing migration files on disk against applied migrations
- `db-migrate.ts:applyMigrations(client, options)` - Applies pending PostgreSQL migrations with session advisory lock db-migrate-#593
- `load-env.ts:loadLocalEnv(dir?)` - Loads .env.local and .env from repository root into process.env without overriding existing shell exports
- `self-improve-operator.ts` - CLI entry point managing operator approval decisions and surface permissions
- `seed-tenant-assignments.ts` - CLI seeding operator tenant assignments and repository ownership
- `seed-test-data.ts` - CLI populating deterministic test datasets across Dark Factory stores
- `df-membership.ts` - CLI managing operator and customer tenant memberships
- `amm-scan.ts` - CLI measuring repository against Autonomous Maintenance Maturity (AMM) catalog
- `dark-factory-local-run.ts` - CLI setting up local Dark Factory runner workspace and verifying prerequisites
- `df-retire-claim.ts` - CLI retiring stale or orphaned issue execution claims
- `sandbox-up.ts` - CLI provisioning local OpenSandbox environment and running vault proofs
- `sandbox-smoke.ts` - Smoke test verifying OpenSandbox container lifecycle and execution
- `df-sandbox-clean.sh` - Shell script deleting sandboxes and pods in local minikube opensandbox namespace
- `df-sandbox-down.sh` - Shell script tearing down OpenSandbox Helm release and namespaces
- `df-cost-budget.ts` - CLI inspecting and adjusting LLM budget caps
- `openrouter-verify-models.ts` - CLI validating declared model IDs against live OpenRouter catalog
- `openrouter-check-prices.ts` - CLI checking provider model prices and updating local floor data
- `df-calibration-report.ts` - CLI generating plan cost estimate calibration metrics
- [k8s-vault-proof](./k8s-vault-proof/README.md) - Local Kubernetes dev harness and end-to-end verification scripts for OpenSandbox Credential Vault
- [sandbox-vendor](./sandbox-vendor/README.md) - Offline artifact vendoring script and digest lock ensuring reproducible OpenSandbox container images

## Invariants
- [coverage-ratchet.ts] Fails if any test coverage metric falls below committed baseline; requires a passing Vitest report
- [db-migrate.ts] Applied migrations are immutable: checksum mismatches or missing migration files result in strict refusal
- [db-migrate.ts] Migration runs must acquire PostgreSQL session advisory lock to prevent concurrent execution
- [seed-tenant-assignments.ts] Refuses to reassign repositories already assigned to a different tenant
- [seed-test-data.ts] Deterministic IDs and timestamps ensure idempotent seeding; unmeasured metrics remain absent rather than zero
- [load-env.ts] Shell and CI environment variables remain authoritative over .env.local values
- [df-sandbox-clean.sh] Refuses execution unless active kubectl context matches local minikube to prevent accidental remote deletion
- [openrouter-verify-models.ts] Refuses to write receipt if any declared model is unverified in live catalog

## Side Effects
- [coverage-ratchet.ts] Reads coverage-summary.json, vitest-report.json; writes coverage-baseline.json with --update
- [db-migrate.ts] Executes PostgreSQL DDL/DML migrations and writes schema_migrations records
- [seed-test-data.ts] Inserts/resets rows in SQLite and PostgreSQL stores
- [dark-factory-local-run.ts] Clones Git repositories, creates local workspace directories, and spawns runner processes
- [sandbox-up.ts / df-sandbox-clean.sh / df-sandbox-down.sh] Executes minikube, kubectl, helm, and docker commands; mutates local cluster state
- [openrouter-verify-models.ts / openrouter-check-prices.ts] Issues HTTPS requests to OpenRouter; writes model receipts and floor data
- [df-retire-claim.ts] Calls GitHub API to reconcile labels and updates run history stores

## Verification
- Run: `npm test`
