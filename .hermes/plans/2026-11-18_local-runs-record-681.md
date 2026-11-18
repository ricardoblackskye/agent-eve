# #681 — a locally-driven run writes no run row, and the store was never the reason

**Issue:** [#681](https://github.com/ricardoblackskye/agent-eve/issues/681) (child of #666)
**Branch:** `fix/local-runs-record-681`, based on `origin/main` @ `57dde53`

## Goal

A run driven by the local launcher leaves a row in `df_run_summaries`, so the run history can see it.

## What the recon established (and where the issue was wrong)

The issue said the cause was the write path, and I posted a correction on PR #680 saying the same. Then,
re-reading the code while planning this, I doubted it and checked. Three facts settle it:

**1. The store is the local container, and the runs point at it.** Every launcher sets it explicitly:

```bash
export DF_RUN_HISTORY_DRIVER=postgres
export DF_RUN_HISTORY_DATABASE_URL="postgres://postgres@localhost:5432/darkfactory?sslmode=disable"
```

That also satisfies the preflight, which **refuses a hosted store for a local run** (`remote-store-refused`:
"a hosted store carries a certificate a local run cannot verify") — so `.env.local`'s Supabase DSN is not
in play, and the store split is **not** the cause.

**2. The store is written, and by these very runs.** The local container holds **12 plans, including
story ids 224, 226, 228 and 230** — the real runs. So `recordPlan` reaches it, and reachability is not
the question. (The issue's "`df_plans` being non-zero proves the store works" reasoning was right for the
wrong reason: those rows are *these runs'* plans, not historical ones.)

**3. No run row was ever written — not a delivery, not a summary.**

```text
total summaries: 0
total deliveries: 0
total plans: 12
```

**And the runner never calls the summary writer.** `recordRunSummary` has exactly one production caller
in the whole repo:

```text
agent/lib/dark-factory/diff-capture.ts:100   await store.recordRunSummary(summary);
```

The runner imports `recordRunActualCost` and calls it once (line 1994). It calls `beginRunRecord`, which
calls `acceptDelivery` — and `acceptDelivery` writes `df_run_deliveries`, which is **also** zero.

So there are two candidate gaps, and Task 1 pins which:

- **(a)** `beginRunRecord`'s `acceptDelivery` never writes. On a resume it is *refused* — the #228/#230
  runs logged exactly that (`activeConflict`: "the ledger already holds an active run ... so this attempt
  was not recorded"). But a **first** run on a fresh ticket should have written a delivery, and none exists.
- **(b)** the runner never writes a **summary** at all, which is true regardless: the only caller is the
  diff-capture path, which the local launcher does not reach.

(b) is certain from the code. (a) is the open question, and the delivery table being empty while the
plans table is not is what makes it worth pinning rather than assuming.

## Impact, and why it is worth fixing

Anything reading the run history is blind to local runs:

- the run listing and the dashboard, which page from `df_run_summaries`;
- status counts and the terminal trend;
- **"how many attempts has this ticket had"** — the visibility ADR 0086 assumes when it says a retry
  accumulates as rows. That claim is true on the dispatch path (and tested there) and silently false on
  the launcher path.

The cost record is *not* affected: `recordRunActualCost` runs, so usage lands while the run does not.
That asymmetry is what makes a partial record look complete.

## Intended fix

**The runner records its own run**, at the point it knows the outcome, by calling `recordRunSummary`
with a summary built from what it already has: the run id the ledger minted (or the attempt id when the
ledger fell back), the repo and issue, the terminal status, and the timings it already computes.

Task 1 pins whether a delivery is also missing on a fresh ticket. If `acceptDelivery` is silently
failing on the local path, that is a second defect and belongs in its own issue — this one is about the
run being invisible, and a summary row makes it visible either way.

**Respect the claim semantics.** `acceptDelivery` is the ADR 0026 atomic claim, and #675/#373 make a
resume adopt a `blocked` holder rather than re-claim it. This change must not disturb that: it writes a
**summary** for the run the runner is already running, and does not acquire, release or re-key a claim.

No ADR: the decision that a run is recorded is not new — it is what the dispatch path already does, and
what ADR 0086 assumes. This makes the launcher path agree with both.

## Tasks (TDD — RED and GREEN as separate commits)

### Task 1 — establish which write is missing, and record it

A test that drives `beginRunRecord` against a store stub and asserts what it asks the store to do,
plus a probe against the real local container for a **fresh** ticket id. The probe is the part that
settles (a): if a delivery appears, `acceptDelivery` works and only the summary is missing; if it does
not, the delivery gap is real and gets its own issue.

### Task 2 — RED: a run the launcher drives asks the store for a summary

The assertion: after the run reaches a terminal state, the store has been asked to record a summary for
the run id it used. Asserted through the store seam, not against Postgres, so the test needs no database.

### Task 3 — GREEN: build and record the summary

### Task 4 — confirm on the real stack

Run the launcher once against a ticket, then:

```sql
select count(*) from df_run_summaries;   -- 0 before, 1 after
```

That is the issue's own reproduction, run forwards. Do not edit the local container's data.

## Files likely to change

| File                                                        | Change                                       |
|-------------------------------------------------------------|----------------------------------------------|
| `scripts/dark-factory-runner.ts`                            | record the summary once the outcome is known |
| `agent/lib/dark-factory/run-summary-from-run.ts` (name TBD) | build a summary from what the run has        |
| `tests/dark-factory/*.test.ts`                              | Tasks 1-2                                    |

## Validation

- `npx vitest run tests/dark-factory/run-record-refusal.test.ts tests/dark-factory/run-history-postgres.test.ts`
- The **full** suite before the push, with CI's DB env vars and
  `--exclude 'tests/env-example-coverage.test.ts'`. #679's baseline to hold is 3684 passed / 0 failed.
- `npx tsc --noEmit --incremental false`
- The **whole** local gate, every check gated rather than printed: suite, `tsc`, cspell's summary text,
  markdownlint with a config **file**, the pinned table formatter, and the coverage ratchet. A known
  load flake (`vault-proof-redaction`) is re-run in isolation and only forgiven if that passes.

## Risks and open questions

- **The delivery gap may be a second defect.** Task 1 pins it. If `acceptDelivery` fails silently on a
  fresh local ticket, that is worth its own issue — and worth knowing before anyone trusts the ledger's
  claim bookkeeping on the local path.
- **A summary needs fields the runner may not have.** The dispatch path builds one from a delivery; the
  launcher has a plan, timings and an outcome. Whatever is genuinely unknown must be recorded as absent
  rather than invented — a summary with a fabricated field is worse than a missing row, because it reads
  as complete.
- **Not in scope:** the dispatch path (already covered by `run-history-postgres.test.ts:257`), the
  dashboard's own paging, and #686 (the coverage floor).
