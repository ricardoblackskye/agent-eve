# ARCH-001: Database Migration Strategy — Captured Risks & Future Work

**Status:** Draft / Captured for review
**Context:** #593 — Migration runner implementation (forward-only)
**Related:** #594 — Epic: Migration tooling beyond forward-only

This document captures the three architectural concerns raised during the review of the forward-only migration runner (#593). They are recorded here so the decision to build, defer, or reject each one is deliberate.

---

## 1. Down / Rollback Migrations

**What it is:** A mechanism to reverse an applied migration without writing SQL by hand.

**Why it was left out of #593:**
- Automated rollback is the most dangerous migration tooling. A wrong down-script destroys data, and the existence of a rollback option encourages applying changes without a snapshot.
- The forward-only runner already runs each file in its own transaction. A migration that fails halfway rolls back cleanly — the common failure mode is covered without a separate down path.

**Decision to make later:**
- Is rollback actually needed, or is "restore the snapshot and fix forward" the accepted recovery path?
- If needed: paired `.up.sql`/`.down.sql` files (easier to review) or a `-- down` section in each file (keeps the pair in one diff)?
- How do we prevent a rollback from silently dropping rows that a later migration depends on?

**Recommendation:** Do not build until a real incident needs it. Document "fix forward or restore the snapshot" as the supported recovery path. Revisit only if that proves expensive in practice.

---

## 2. Schema Diff Engine

**What it is:** Generate a migration from the difference between the adapters' runtime DDL and the database's actual schema — catching drift automatically instead of via checksum mismatches on applied files.

**Why it was left out of #593:**
- The adapters create tables with `CREATE TABLE IF NOT EXISTS`, and the migrations are handwritten. A diff engine would need to parse TypeScript template strings or introspect a live database and emit SQL. Generated SQL that nobody reviewed is how production incidents happen with a clean CI badge.
- `migration-rls.test.ts` already cross-checks that every adapter table has an `ENABLE ROW LEVEL SECURITY` command. That covers the specific divergence that caused #591.

**Decision to make later:**
- Introspect a reference database vs. parse the adapter DDL? Introspection is more accurate but needs a database in CI; parsing is brittle but hermetic.
- Should the output be a migration file for review, or a CI check that fails and tells you what to write? The second is much safer.
- Who owns the diff when an adapter table legitimately has no migration (runtime-only state)?

**Recommendation:** Build the CI *check* first — "the live schema matches the migrations" — and never auto-generate a file that applies without review. The check is cheap; the generator is a foot-gun.

---

## 3. Hosted Migration Service / Dashboard

**What it is:** Operational visibility — which environments have which migrations, when they were applied, who triggered them — instead of reading CI logs and `schema_migrations` rows.

**Why it was left out of #593:**
- It is a product, not a script. It needs auth, audit, environment inventory, and a UI. For a single-operator repo, CI logs plus `--status` already answer the question.

**Decision to make later:**
- Is the problem "we cannot see the state" (a dashboard over `schema_migrations`) or "we cannot control who applies" (a service with approvals)?
- Would a scheduled `--status` report to Slack/email answer the visibility need without building a service?
- If a service: does it run migrations, or only observe and trigger the existing runner?

**Recommendation:** A scheduled `--status` report first. Build the service only when more than one operator or environment makes log-reading genuinely expensive.

---

## Acceptance criteria for the Epic (#594)

1. Each of the three capabilities has a recorded decision: build, defer with a condition, or reject — with the reason.
2. No capability is built without a named incident or operational cost that justifies it.
3. If one is built, it gets its own issue with acceptance criteria and a TDD plan, not a paragraph in an Epic.

## Notes

- These are roadmap items, not commitments. This document exists so the deferral is explicit.
- #593's plan documents why each was left out; this document is the place to revisit that reasoning.
- Nothing here changes the forward-only runner's design. If a decision later contradicts it (e.g., paired down migrations), that is a new design discussion, not a silent edit to #593.
