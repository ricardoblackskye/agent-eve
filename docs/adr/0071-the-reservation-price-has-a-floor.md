# 0071 — The reservation price has a floor, and staleness is a warning

- **Date:** 2026-10-27
- **Status:** Accepted

## Context

ADR 0027 requires `modelPriceTable` to hold the dearest published provider rate, because `admit()`
reserves against it before a call and only trues up at `settle()`. Under-reserving therefore lets a
cap be passed with the money already spent.

The table is hand-maintained, and it fell behind. Measured on a single day, the dearest output rate
for the default model went `0.004177242`, `0.005559908`, `0.006115898`, `0.006727487`, `0.013109965`,
`0.015863057` — a factor of 3.8 — while the table sat at `0.0024` throughout.

ADR 0070 replaced the blocking live assertion with a scheduled check and a test-side receipt. That
stopped the build going red on unrelated PRs, but it left the *reservation* reading a constant with no
relationship to the record the guard checked: the observation lived under `tests/`, and the
reservation path runs in `agent/`.

## Decision

The reserved price is the higher of the shipped ceiling and a shipped **floor** of the dearest rate
actually verified.

- `resolvePrice` returns `max(table, floor)`, axis by axis. The floor can only ever raise the reserved
  number, so it is inert while the table carries headroom and protective the moment the table falls
  behind.
- The observation has **one home**: the generated `agent/lib/dark-factory/model-price-floor-data.ts`,
  written by `npm run prices:check -- --write` through a renderer that lives beside the type it writes.
  It is shipped rather than test-side, because the record the guard checks must be the record the
  reservation reads. This retires ADR 0070's test-side receipt; 0070's scheduling decision stands.
- **The env override still wins.** `DF_MODEL_PRICE_<stableId>` is the documented escape hatch for an
  operator who knows the provider in use, and pinning a cheaper provider is a legitimate reason to set
  it. The floor guards the shared table, not an explicit per-deployment act.
- The writer **refuses** to record an observation it cannot substantiate: an unreadable catalog, a
  missing model, or a ceiling below the dearest observed rate each exit 1 with nothing written.
  Refreshing the record and raising the ceiling are therefore one deliberate act, not two that can
  drift apart.
- **Staleness is a warning, not fatal.** `prices:check` prints it and the scheduled workflow raises it.
  This follows ADR 0067, which faced the same choice for the model-id receipt and recorded it as
  "knowingly the weaker of the two options". A fail-closed floor would refuse to run the factory once
  the observation lapsed, turning a housekeeping lapse into an outage.
- A commit-time guard fails the build when a shipped ceiling sits below the recorded rate, so the table
  cannot silently rot while the floor quietly covers for it.

## Consequences

- A provider price rise can no longer leak into spend below the last verified rate: the reservation
  rises with the floor and needs no code change.
- The floor is only as fresh as the last verification. A rise occurring after that check is still
  under-reserved for up to the workflow's interval. This states that bound rather than implying a
  guarantee the design cannot make — the bound is the schedule, not the code.
- The ceiling must still be raised deliberately when drift is reported, because the writer refuses to
  record an observation the ceiling does not cover.
- Two numbers now have to agree. The build checks one direction (ceiling at or above the record) and
  the scheduled check covers the other (record against the live catalog).
- An unpriced model still fails closed: the floor cannot price a model that has no shipped ceiling.
