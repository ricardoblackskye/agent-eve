# Persist plans and their cost estimates as queryable data (#486)

Epic: **#453 Agents Cost Estimator** · Issue: **#486** · Branch: `feat/df-persist-plan-estimate-486`
Base: `595e88e` (merge of #493) · Depends on: #485 (merged)

## Goal

Give the advisory band from #485 a durable, **analytically queryable** home, so it can be compared
with the run's actual cost and so #490 has data to calibrate against.

## Why this is not a column on df_run_summaries

An earlier draft of this plan stored the estimate as one JSON/JSONB column on the run summary.
Reshaped after review, for three reasons:

1. **A run can have N plans.** `ArchitectAgent.amendPlan` exists, and `plan-approval.ts` tracks a
   revision round for a re-park after revision (#378). One column can hold only the LAST estimate,
   so the trajectory across revisions — itself a signal — would be silently destroyed.
2. **The summary row is rewritten on every lifecycle event.** An estimate is written once, at plan
   time. Putting it on the summary means it is rewritten, and at risk of being nulled, dozens of
   times per run for no benefit.
3. **BI cannot aggregate a blob.** Grouping by cost class over JSONB means a scan plus a cast per
   query, and no index. The whole point of persisting is to answer questions in SQL.

## Verified state on main

| Fact | Where |
|---|---|
| `PlanCostEstimate` exists: low, expected, high, class, confidence, features | `plan-cost-estimate.ts:73` |
| `amendPlan` exists; an amendment is a real re-plan | `architect-agent.ts:981` |
| A re-park after revision is its own round | `plan-approval.ts:100` |
| **No plan table exists** — plans live only as GitHub comments | 15 tables, none of them a plan |
| `RunEvent` forbids raw prompts and free-form issue content | `run-history.ts:96` |
| sqlite migration pattern: PRAGMA table_info then ALTER TABLE | `run-history-store.ts:926` |
| Postgres migration pattern: ADD COLUMN IF NOT EXISTS | `run-history-postgres.ts:146` |

## Schema

Three objects, in the same database as the run ledger so the accuracy join works.

```sql
CREATE TABLE IF NOT EXISTS df_plans (
  plan_id        INTEGER PRIMARY KEY AUTOINCREMENT,   -- BIGSERIAL on Postgres
  run_id         TEXT    NOT NULL,
  tenant_id      TEXT,
  plan_revision  INTEGER NOT NULL,
  story_id       INTEGER NOT NULL,
  source         TEXT    NOT NULL,      -- 'architect' | 'amendment'
  plan           TEXT    NOT NULL,      -- JSONB on Postgres: the structured ExecutionPlan
  comment_ref    TEXT,                  -- GitHub comment id and url; the prose lives there
  created_at     TEXT    NOT NULL,
  UNIQUE (run_id, plan_revision)
);

CREATE TABLE IF NOT EXISTS df_plan_estimates (
  estimate_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id            INTEGER NOT NULL REFERENCES df_plans(plan_id) ON DELETE CASCADE,
  run_id             TEXT    NOT NULL,
  tenant_id          TEXT,
  period             TEXT    NOT NULL,  -- YYYY-MM, the cost-budget period key
  estimator_version  TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  low_usd            REAL    NOT NULL,
  expected_usd       REAL    NOT NULL,
  high_usd           REAL    NOT NULL,
  cost_class         TEXT    NOT NULL,  -- XS | S | M | L | XL
  confidence         TEXT    NOT NULL,  -- low | medium | high
  revision_factor    REAL    NOT NULL,
  history_samples    INTEGER NOT NULL,
  target_file_count  INTEGER NOT NULL,
  task_count         INTEGER NOT NULL,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  price_source       TEXT    NOT NULL,
  stage              TEXT,              -- NULL is whole-run; set once #492 lands per-stage
  features           TEXT    NOT NULL,  -- JSONB on Postgres: the open-ended long tail
  created_at         TEXT    NOT NULL
);

CREATE VIEW IF NOT EXISTS df_plan_estimate_accuracy AS
SELECT e.period, e.cost_class, e.confidence, e.estimator_version,
       e.expected_usd, s.cost_usd AS actual_usd,
       (e.expected_usd - s.cost_usd) AS signed_error_usd
FROM   df_plan_estimates e
JOIN   df_run_summaries  s ON s.run_id = e.run_id
WHERE  s.cost_usd IS NOT NULL;
```

Indexes: period plus cost class for the calibration rollup, run_id for the detail view, tenant_id
plus period for tenant aggregation.

## Design decisions

**Typed columns plus one JSONB tail.** The five fields you will slice by — period, cost class,
confidence, estimator version, tenant — are real columns, so grouping is native and any BI tool can
connect. The features vector stays JSON so the estimator can grow it without a migration.

**estimator_version is mandatory.** When #490 recalibrates the band multiplier, older rows were
produced by a different model. Without a version stamp the bias analysis silently mixes models.

**Persist the structured ExecutionPlan.** Approved: it is a typed schema, not prose, so it is a
different category from the free-form content `RunEvent` bars. It is what makes replay of a past plan
possible — re-extract features later without re-reading GitHub.

**Never persist issue or plan prose.** `comment_ref` points at the GitHub comment where the text
lives. Storing it would duplicate an untrusted, mutable document.

**The band is written once and never rewritten.** It lives in its own row, so no lifecycle write can
null it — the failure mode the column design carried.

## Two caveats carried from review

1. **Whole-run granularity.** The summary cost is a run total, so estimate-vs-actual is only
   meaningful per run until **#492** puts architect events in the usage ledger. The `stage` column
   is nullable and reserved, not pretended.
2. **estimator_version from row one**, per above.

## Store seam

A separate `PlanLedger` interface, implemented by both existing stores, rather than widening
`RunHistoryStore`. Widening the run-history interface would force every implementer and the
notifying decorator to change for a domain they do not care about.

## Tasks — RED then GREEN

| # | Task | RED asserts |
|---|---|---|
| 1 | Plan persistence | a plan round-trips; revision 1 and revision 2 both survive, ordered |
| 2 | Estimate persistence | band, class, confidence and features round-trip; the version is stored |
| 3 | Absent is not zero | a plan with no estimate has no estimate row, never a zero-filled one |
| 4 | Accuracy view | the view returns one row per estimated run, with a signed error |
| 5 | Validation | inverted band, unknown class, non-scalar feature and bad source are refused |

## Files

| File | Change |
|---|---|
| `agent/lib/dark-factory/plan-ledger.ts` | NEW — record types, validators, `PlanLedger` seam |
| `agent/lib/dark-factory/run-history-store.ts` | schema, migration, sqlite implementation |
| `agent/lib/dark-factory/run-history-postgres.ts` | schema, migration, Postgres implementation |
| `tests/dark-factory/plan-ledger.test.ts` | NEW — validators |
| `tests/dark-factory/plan-ledger-sqlite.test.ts` | NEW — round-trip, absent case, revisions, view |
| `docs/pages/dark-factory-modules.md` | catalog row for the doc-drift guard |

## Validation

- Each RED watched failing before its GREEN.
- Full suite, with the tally read from a redirected log.
- tsc with the incremental flag off.
- cspell over the derived changed-file list.
- SQL arity checked statically for the Postgres statements.
- The Postgres suite must run in CI; it cannot run on this host.

## Risks

1. **Postgres cannot be executed here.** No cached image and no network, so static arity is not
   proof. CI is the first real run.
2. **A new table pair is more surface than a column.** Justified by revision cardinality and the BI
   requirement; the run summary stays untouched, which is the win.
3. **The view joins a run total** — see caveat 1. It needs a stage dimension before it answers
   per-stage questions.
