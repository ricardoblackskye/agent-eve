# 0070 — A price ceiling is checked on a schedule, not asserted in the unit suite

- **Date:** 2026-10-27
- **Status:** Accepted

## Context

ADR 0027 requires `modelPriceTable` to hold the **dearest** published provider rate for each
shipped model, because `admit()` reserves against the table before a call and only trues up at
settle. An under-priced entry therefore lets `spent + reserved + estimate` pass the cap with the
money already spent.

That requirement was enforced by a live contract test running inside the default unit suite. ADR
0067 recorded the consequence and deferred it: `tests/model-price-ceiling.contract.test.ts` still
carried the older pattern, "tracked separately".

The deferred cost arrived. A unit test asserting our constant against a number the provider
changes is red for reasons no PR can fix. Measured dearest output rate for the default model on a
single day:

| Read | Dearest provider rate (USD per 1k) |
| --- | --- |
| first measurement | 0.004177242 |
| a few hours later | 0.005559908 |
| CI, hours after that | 0.006115898 |

Roughly +46% in one day. `main` went red, and the plan-ledger PR (#495) was blocked by a check
whose subject it does not touch. Raising the ceiling is necessary but is only a delay: the fix
that pinned the literal measured maximum would have been red within the hour.

## Decision

The price guard is split the way ADR 0067 split the model-availability guard.

- A committed receipt at `tests/support/openrouter-price-receipt.json` records the dearest rate
  that was **actually observed** per declared model, with the date, the provider count and the
  endpoint it came from. It is what was seen, not a mirror of the catalog.
- The unit suite asserts, hermetically, that every declared model has a receipt entry and that the
  shipped ceiling still covers the receipt on both axes. It touches no network, and it can only go
  red when **we** change a ceiling or add a model.
- `npm run prices:check` performs the live comparison. It **refuses** - exit 1, nothing written -
  when the catalog cannot be read or a ceiling is below the dearest observed rate. A receipt
  written under those conditions is theatre.
- Drift is reported by the scheduled `Price Drift` workflow, which opens or updates an issue. It is
  **not** a required check and is deliberately not named `Unit Tests`, because the branch ruleset
  gates on that check name.
- Shipped ceilings keep deliberate headroom above the dearest observed rate. ADR 0027 is explicit
  that over-reserving is transient (released at settle) while under-reserving is not.

## Consequences

- A provider price rise no longer blocks a PR. That is the point: the drift signal is decoupled
  from the merge gate.
- Detection now depends on the scheduled workflow existing. **Deleting it removes the detection
  silently** - nothing fails, the check simply stops running. This is the same caveat ADR 0067
  recorded for its `LIVE_CONTRACT` flag, and it is the price of not blocking merges.
- The live comparison no longer runs on every push, only daily. A ceiling can be stale for up to a
  day, bounded by the schedule.
- Refreshing the receipt is part of raising a ceiling, not an optional extra. The hermetic test
  fails if the ceiling is lowered below the receipt, which is what makes the receipt load-bearing
  rather than decorative.
- The receipt carries a provider count so a thin or partial upstream response is visible rather
  than silently narrowing the observation.
- `tests/model-price-ceiling.contract.test.ts` is removed; its live assertion is now the
  `prices:check` script.
