# Issue #146 — R4b: recurrence, trend and the operator override

**Branch:** `feat/df-self-improve-cadence` (off `origin/main` = `98804b3`, which contains R4a)
**Issue:** #146 · **Release:** R4b of 2 · R4a merged as PR #154
**Closes:** #146 (this release carries the final AC, AC6)

## Goal

R4a can run **one** bounded cycle. R4b makes the loop *recur* and makes its
cumulative effect **provable**, which is the whole point of "measurable
recursive self-improvement": a single accepted step proves nothing, and an
unverified loop will happily improve itself into a regression.

Three parts:

1. **Cadence** — decide *when* a cycle is due.
2. **Trend (AC6)** — report the objective over N cycles, proving cumulative
   improvement rather than a single step.
3. **Operator override** — let a human approve/deny a change out of band,
   fail-closed, without a long-lived process waiting on input.

## Verified current state (read from `main` @ `98804b3`)

| Fact | Consequence |
| --- | --- |
| R4a exports the full loop: `runImprovementCycle`, `ImprovementLedger`/`LedgerEntry`, `OperatorGate`, `CycleResult`, `createSelfImprovementController` | R4b builds on these; no R4a behaviour changes. |
| `StateStore` (#134) is `save(key, value)` / `get<T>(key)` / optional `close()` | Durability already exists as a seam — the cadence watermark and operator decisions reuse it. **No new storage.** |
| `self-improve.ts` imports only `node:fs`, `node:path`, `./metrics`, `../quality-gate` — **no persistence** | Keep it that way: the operator store goes in its own module so the controller stays storage-agnostic. |
| `OperatorGate.approve(proposal)` is `Promise<boolean>`, and R4a blocks when the gate is **absent** | An out-of-band operator cannot answer mid-request, so the gate must be *pre-armed* by a recorded decision rather than waiting on input. |

## Design decisions (and why)

### 1. Cadence is a DECISION FUNCTION, not a timer

`#127`'s premise is that the factory runs out-of-band because a single Vercel
serverless function cannot host long-running loops. A `setInterval` therefore
cannot be the cadence: the process does not live long enough, and an in-process
timer would silently never fire in production while passing locally.

So cadence is pure: the caller's scheduler (Vercel Cron, a GitHub Action, an
operator) asks *"is a cycle due?"* and the answer comes from a persisted
watermark. No timers, no background loops, fully unit-testable offline.

### 2. The operator gate is PRE-ARMED, not awaited

R4a already fails closed on a missing gate. R4b gives the gate a durable source:
an operator records a decision (`allow`/`deny`) for a (surface, kind) pair with
an optional expiry, and `operatorGateFromStore` turns those records into the
`OperatorGate` R4a consumes. Fail-closed in every degenerate case: no record,
expired record, or an explicit `deny` ⇒ `approve()` returns `false`.

This is the "operator override for an out-of-band change" the issue asks for,
without inventing a pending-request/resume state machine that nothing would
drive.

### 3. **Not** shipping a standalone CLI binary — with the reason

The repo has no TypeScript runtime for `scripts/`: `scripts/pr-reviewer.js` is
plain JS, and Node's type-stripping cannot resolve this repo's extensionless
relative imports (`./state`, `../quality-gate`). Shipping a CLI would mean either
a new dependency or duplicating the store's key scheme in JS — both worse than a
documented typed API. The operator surface is therefore an API
(`record` / `get` / `list` / `clear`) plus a runnable demo, and a CLI wrapper is
a follow-up once a TS script runner exists. Flagged here rather than silent.

## Tasks (TDD, vertical tracer bullets)

Scaffold first: declare each new export with its real signature and a
`throw new Error("not implemented")` body so tests fail on **behaviour**, not on
import.

| # | RED (failing test first) | GREEN (minimal impl) | AC |
| --- | --- | --- | --- |
| 1 | `isCycleDue` with no watermark ⇒ due; watermark older than the interval ⇒ due; newer ⇒ not due | pure `isCycleDue({lastRunAt, now, intervalMinutes})` | cadence |
| 2 | exactly at the interval boundary ⇒ due (exact-boundary test, not just above/below) | comparison uses `>=` | cadence |
| 3 | an unparseable watermark throws rather than silently running or never running | `SelfImprovementConfigError` | cadence |
| 4 | `objectiveTrend([])` ⇒ empty points, null first/last/delta, not improving (no throw) | `objectiveTrend(entries)` | AC6 |
| 5 | N cycles ⇒ points in order, `first`/`last`/`delta`, accepted+rejected counts | same | AC6 |
| 6 | a filtered surface reports only its own cycles | `objectiveTrend(entries, {surfaceId})` | AC6 |
| 7 | a ledger whose objective regressed over time reports `improving: false` and a negative delta | same | AC6 |
| 8 | operator store round-trips a decision through a real `StateStore` | `createOperatorDecisionStore(store)` | override |
| 9 | `operatorGateFromStore` allows only on a non-expired `allow`; denies on `deny`, on expiry, and when nothing is recorded | gate factory | override |
| 10 | `list()` returns recorded decisions; `clear()` removes one | store API | override |
| 11 | `DF_SELFIMPROVE_INTERVAL_MINUTES` parses (digits-only, ≥ 1) and rejects garbage | env wiring | conventions |
| 12 | an end-to-end run: due ⇒ cycle runs and the watermark advances; not due ⇒ the cycle is skipped | `runScheduledCycle` glue | cadence + AC6 |

## Files likely to change

- `agent/lib/dark-factory/self-improve.ts` — `isCycleDue`, `nextRunAt`, `objectiveTrend`, `runScheduledCycle`, the interval env var.
- **NEW** `agent/lib/dark-factory/self-improve-operator.ts` — decision store over `StateStore` + `operatorGateFromStore`.
- **NEW** `tests/dark-factory/self-improve-cadence.test.ts`, **NEW** `tests/dark-factory/self-improve-operator.test.ts`.
- `agent/lib/dark-factory/index.ts` — re-export the R4b symbols.
- `.env.example` + `tests/dark-factory/env-docs.test.ts` — `DF_SELFIMPROVE_INTERVAL_MINUTES`.
- `README.md` — R4b section.

New env var (**config**, digits-only, ≥ 1; default `1440` = daily):

| Var | Default | Meaning |
| --- | --- | --- |
| `DF_SELFIMPROVE_INTERVAL_MINUTES` | `1440` | Minimum minutes between cycles. Consulted by the caller's scheduler via `isCycleDue`. |

## Validation

- `npx tsc --noEmit` clean; full `npx vitest run` with no new regressions.
- Local lint gate before push: cspell on changed files (incl. this plan and
  `.env.example`), prettier scoped to changed files only.
- A runnable local demo: two cycles driven through the cadence policy showing the
  watermark advancing, the trend delta, and a denied override blocking a change.

## Risks / open questions

- **Watermark vs. real schedule drift.** The watermark records *our* last run,
  not the scheduler's intent; a missed schedule simply runs on the next
  invocation. That is acceptable for improvement work (idempotent-ish, budget
  guarded) and is stated rather than hidden.
- **Operator decisions are durable but not authenticated.** Anyone who can write
  the state store can pre-arm an `allow`. That is the same trust boundary as the
  existing `DF_STATE_*` configuration, and it is recorded (`decidedBy`) for
  audit; adding authn is a deployment concern, not this seam's.
- **A trend over few cycles is weak evidence.** `objectiveTrend` reports the
  delta and the counts so a single step cannot masquerade as improvement, but it
  does not add statistical significance testing — out of scope, noted.

## Status

Implementation proceeds under the `proceed` clearance (GATE 1). **A PR will not
be created until you explicitly authorize it** (GATE 6).
