# #427 — the overview page must not disappear when ONE source is down

## Root cause (reproduced, not inferred)

I ran main locally with a reachable membership store and an UNREACHABLE run-history store, and got exactly
the reported symptom. The APIs told the story:

```
/api/dark-factory/metrics        503  {"error":"Run history is unavailable"}
/api/dark-factory/runs?limit=5   503
/api/dark-factory/usage          200   <- healthy, real data
/api/dark-factory/cost-budgets   200   <- healthy, real data
```

...and `/dark-factory` served ONLY `Loading factory status…`. Every panel was gone.

The page has three page-wide early returns (`app/dark-factory/page.tsx`):

1. `authRequired` - a signed-out visitor gets the sign-in panel. Legitimate.
2. **`overviewError.blocking` - an error state that REPLACES the entire board.**
3. initial loading.

`resolveOverviewError` considers only `metrics` and `runs`, and returns `blocking` when one failed and NEITHER has
data. So a dead run-history store blanks the whole page - and the LLM COST BUDGETS and LLM USAGE panels are destroyed
with it, even though they are served by entirely DIFFERENT stores (usage, cost-budget) that were answering 200 with
real data. Their by-model / by-task-type / by-day / by-run breakdowns went with them.

That is precisely the report: those tiles "all gone", while the page itself still renders.

## Why it was not caught (the question the issue asks)

Both existing tests ask the wrong question, so the defect looks like intended behaviour:

- `tests/dark-factory-ui/overview-state.test.ts` PINS the current contract, including
  *"blocks the page only when there is no data to keep"* - so the suite asserts the bug is correct.
- `e2e/dark-factory-overview.spec.ts` runs against fully-seeded stores, so every source is healthy and no test
  exercises a PARTIAL outage.

Nothing asserted the property this page actually needs:

> **One failing source must not remove panels served by a healthy one.**

## Fix

**The board always renders.** The only page-wide states left are genuinely page-wide: signed out, and the initial
load before any source has answered.

- `resolveOverviewError` stops deciding whether to blank the page. It reports WHICH sources failed, so the banner can
  name them. A failure with no data is no longer a reason to discard panels that have their own data.
- The metrics/runs-derived sections (KPI tiles, outcome mix, resource snapshot, trend, recent executions) render an
  explicit UNAVAILABLE state when their source failed, instead of silently showing zeroes. "0 active runs" and "the
  run-history store is down" are different facts and must not look identical.
- A failing source is named in the banner, so an operator knows which store to look at.

Deliberately unchanged: a signed-out visitor still gets the auth panel, and the initial load still shows a loading
state. Those are page-wide truths, not one source's failure.

## Tasks

**1 (RED) - the contract.** `resolveOverviewError` reports the failed sources rather than a blocking verdict: a
metrics failure with no data must NOT be blocking, because other panels can still render.

**2 (RED) - the guard the issue is really about.** With metrics and runs failing but usage and cost-budgets healthy,
the page still renders the LLM COST BUDGETS and LLM USAGE panels. Written as a component test AND a browser test that
mocks `**/api/dark-factory/metrics` to a 503, so a partial outage is exercised rather than assumed.

**3 (RED) - honest empty states.** A metrics-derived section whose source failed says so, instead of rendering zeroes
that read as measurements.

**4 (GREEN)** - implement the above in `page.tsx`, `view-model.ts` and the affected sections.

**5** - update the two existing tests whose assertions encode the old, defective contract, and say in the commit why
they changed rather than quietly rewriting them.

## Validation

- `npx tsc --noEmit --incremental false`
- the new tests, then the FULL suite with no `DF_*` exported in the shell
- `npx cspell@9.1.1 -c .cspell.json` over the whole diff, staged first
- the Playwright overview spec, which now includes a mocked partial-outage case
- reproduce the original symptom by hand: run-history down, usage/cost healthy, and confirm the panels survive

## Risks

- **Loosening the error gate could hide a genuine total outage.** That is why the loading state stays, and why each
  failed source is named in the banner rather than silently swallowed: the aim is to stop one failure erasing healthy
  data, not to stop reporting failure.
- **An empty section can still read as a measurement.** Hence task 3: a section whose source failed must SAY it failed.
- **The existing tests encode the defect.** Changing an assertion needs justifying in the commit, not just editing.
