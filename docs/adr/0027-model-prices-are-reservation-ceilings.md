# 0027. Model prices are reservation ceilings, not exact rates

**Status:** Accepted
**Date:** 2026-10-13
**Issue:** #335

## Context

The cost gate reserves before a call and reconciles afterwards: `admit()` computes
`estimateCost(model, maxTokens)` from `modelPriceTable`, the call runs, and `settle()` trues it up
from the cost the caller **measured** (`costOf(result)`). Where a call site measures nothing,
`settle(id, null)` keeps the estimate — ADR 0003, _an unmeasured value is never zero_.

So the table's number decides how much budget is **held**, in one direction only:

- too low → the cap can be passed before anything reconciles;
- too high → budget is held that the call will not spend, and released at settle.

We do not pin an OpenRouter provider, and a model's price differs per provider. Measured from
OpenRouter's endpoints API on 2026-10-13:

| model                          | providers | input /1M (min → max) | output /1M (min → max) |
| ------------------------------ | --------- | --------------------- | ---------------------- |
| `deepseek/deepseek-v4.1-flash` | 32        | $0.0441 → $0.60 (14×) | $0.18 → $2.40 (13×)    |
| `deepseek/deepseek-v4-pro`     | 15        | $0.45 → $1.91 (4×)    | $1.91 → $10.50 (5.5×)  |

OpenRouter's `/models` headline for `deepseek/deepseek-v4.1-flash` is **$0.0441/1M — the cheapest
provider**. Pricing from it would under-reserve by up to ~14×. The obvious number is the wrong one.

Drift made this invisible: the table shipped `deepseek/deepseek-chat`, the pre-#121 default, while the
agent had moved to the v4.1/v4 models. Nothing asserted the two agreed, so switching cost governance
on refused every chat call (`unpriced_model`) — fail-closed, but an outage.

## Decision

1. **Every entry in `modelPriceTable` is a reservation CEILING** — the dearest published provider
   price for that model, per axis — never the headline price, never an average.
2. **Every model id the project ships is priced.** A `*_MODEL_ID` export from `model-config.ts` with no
   price is a build failure.
3. **`DF_MODEL_PRICE_<stableId>` is the exactness lever.** An operator who knows the provider in use
   sets the real rate per deployment, overriding the ceiling without a code change. The stable id is
   the model id lowercased with every non-alphanumeric replaced by `_`. Documented in `.env.example`.
4. **The ceiling is checked against the live catalog.** A contract test (mirroring
   `model-availability.contract.test.ts`: read-only, no key, no spend, skips cleanly offline) asserts
   each ceiling is **≥ the maximum published provider price**, so a new expensive provider or a rate
   rise fails the build instead of silently under-reserving.

## Consequences

- Switching cost governance on can no longer refuse a shipped model for being unpriced; the guard
  fails first, in the build.
- Ceilings must be **maintained**: provider prices move. The contract test is what tells us, and
  `DF_MODEL_PRICE_*` is the escape hatch when a ceiling binds before the table is updated.
- Unmeasured calls settle at the ceiling, so they account for slightly more than reality. That is
  deliberate: over-counting is safe, under-counting is not.
- Per-provider exact pricing (recording which provider served and pricing `(model, provider)`) is the
  truer model and remains out of scope; so does steering routing (`provider: { sort: "price" }`).
