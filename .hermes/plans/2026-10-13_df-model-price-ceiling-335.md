# Plan — #335: price the shipped models as reservation ceilings

**Branch:** `fix/df-model-price-ceiling-335`
**Issue:** [#335](https://github.com/ricardoblackskye/agent-eve/issues/335)

## The defect

`modelPriceTable` (`cost-budget.ts`) ships **one** entry — `deepseek/deepseek-chat` — a model this
project no longer uses. Both models the agent actually ships are **unpriced**:

- `DEFAULT_MODEL_ID = "deepseek/deepseek-v4.1-flash"`
- `FALLBACK_MODEL_ID = "deepseek/deepseek-v4-pro"`

So the moment cost governance is switched on, every chat call is refused (`unpriced_model`). The
drift came in with #121/#122 (the model swap); nothing asserted the table and `model-config.ts` agree.

## Why the table holds a CEILING, not an exact rate

OpenRouter fans a model out across many upstream providers at different prices, and we pin none:

| model                          | providers | input /1M (min → max) | output /1M (min → max) |
| ------------------------------ | --------- | --------------------- | ---------------------- |
| `deepseek/deepseek-v4.1-flash` | 32        | $0.0441 → $0.60 (14×) | $0.18 → $2.40 (13×)    |
| `deepseek/deepseek-v4-pro`     | 15        | $0.45 → $1.91 (4×)    | $1.91 → $10.50 (5.5×)  |

OpenRouter's `/models` headline is the **cheapest** provider, so pricing from it would under-reserve
by up to ~14×. And `admit()` reserves from this table while `settle()` trues up from the **measured**
cost, keeping the estimate where a call is unmeasured (ADR 0003 — unmeasured is never zero).
Under-reserving is the dangerous direction; over-reserving is transient.

## Ceilings to ship (USD per 1k tokens — the table's unit)

| model                          | input   | output |
| ------------------------------ | ------- | ------ |
| `deepseek/deepseek-v4.1-flash` | 0.0006  | 0.0024 |
| `deepseek/deepseek-v4-pro`     | 0.00191 | 0.0105 |

Maximum published provider price per axis, measured from OpenRouter's endpoints API on 2026-10-13.

## Tasks (RED → GREEN)

**T1 (RED) — the consistency guard.** Every model id exported from `model-config.ts` must resolve to a
price. Fails today for both. This is the assertion that would have caught the drift.

**T2 (RED) — the ceiling contract.** Extend the **existing** `model-availability.contract.test.ts`
pattern (read-only, no API key, no token spend, skips cleanly when offline or `MODEL_CONTRACT_OFFLINE=1`)
to `/api/v1/models/<id>/endpoints`, asserting our ceiling is **≥ the maximum published provider price**
per axis. A new expensive provider or a rate rise then fails the build instead of silently
under-reserving.

**T3 (GREEN)** — add the two ceiling entries with a comment stating plainly that they are _reservation
ceilings, not exact rates_, and document `DF_MODEL_PRICE_<stableId>` in `.env.example` (today
undocumented anywhere).

**T4** — KEEP the `deepseek/deepseek-chat` entry: it is an accurate price for a real model, and removing
a price is a bigger statement than adding one. Say so in the comment.

**T5** — ADR 0027: the price table is a reservation ceiling (why a ceiling, not an average).

## Files

- `agent/lib/dark-factory/cost-budget.ts` — `modelPriceTable`
- `.env.example` — document `DF_MODEL_PRICE_*`
- `tests/model-price-ceiling.test.ts` (new) · `tests/model-availability.contract.test.ts` (pattern)
- `docs/adr/0027-*.md`

## Verification

Full suite · `tsc` · cspell · Prettier · `npm run build`.
**Non-vacuity:** lower a ceiling below the published maximum → T2 fails; delete a shipped model's entry
→ T1 fails.

## Out of scope

Per-provider exact pricing (`(model, provider)`) · steering routing (`provider: { sort: "price" }`).
