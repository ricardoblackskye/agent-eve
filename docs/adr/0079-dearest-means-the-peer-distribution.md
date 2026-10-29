# 0079 - "Dearest" means the peer distribution, not one endpoint

- **Date:** 2026-10-29
- **Status:** Accepted

## Context

ADR 0027 requires every entry in `modelPriceTable` to hold the **dearest** published provider rate, because
`admit()` reserves against it before a call and only trues up at `settle()`. ADR 0071 added a shipped floor of the
dearest rate actually verified, so a ceiling that falls behind cannot under-reserve silently.

Both treat "dearest" as the maximum across every provider fronting the model. Measured on 2026-10-27, that maximum
was set by ONE endpoint: 41 providers priced `deepseek/deepseek-v4.1-flash` with a median of 0.00084, a p90 of
0.0012 and a second-dearest of 0.0024 - and a maximum of **0.015863057**, 18.9x the second-dearest and 6.6x the
p90. Its input rate was 0.000006375 beside an output rate an order of magnitude above every peer, which reads as a
special-purpose endpoint priced far apart from the market rather than as a rate.

So one endpoint set the reserved number, with two real consequences:

- the ceiling was raised to 0.02 to cover it, which is 8.3x the dearest provider the catalog returns *today* - that
  endpoint has since vanished;
- every reading reported during the price work (0.004 to 0.0159) was that endpoint repricing itself, and because
  the refresh writer refuses to record an observation the ceiling does not cover, each move forced a ceiling raise.

## Decision

**"Dearest" means the dearest rate within the peer distribution. A provider far above its peers is reported, not
reserved against.**

- The refresh path keeps the provider rates instead of reducing them to a maximum, and adopts a rate **capped at
  3 x p90**, recording the distribution (median, p90, second-dearest, providers) in the observation it writes.
- A provider above the cap is recorded as `declinedDearestUsdPer1k` and printed, so it is visible at the moment it
  would have been adopted rather than discovered later. It never sets the reservation.
- The multiple is **3**, derived from the readings rather than chosen for convenience: on 2026-10-29 p90 was
  0.0012, so the cap is 0.0036 - inert against that day's dearest (0.0024) and binding against the 0.015863057 of
  2026-10-27. Both readings are asserted, because a rule that binds when no outlier exists is a different defect
  with the same symptom.
- The shipped ceiling is deliberately NOT the cap. It sits at **cap x 1.25** (0.0045): above what the rule can
  adopt, so it does not bind the reservation, with a margin for a rise occurring between verifications - the
  interval ADR 0071 states is covered by headroom rather than by code.
- The `DF_MODEL_PRICE_<stableId>` override still wins, unchanged (ADR 0027).

## Consequences

- **The bound is over the peer distribution, and that is a deliberate reduction in coverage.** A call actually
  routed to a far outlier can exceed the reservation, which is what the cap means. The alternative - adopting the
  maximum forever - over-reserves against providers we cannot reach, which is the 8.3x this record removes. The
  trade is stated here rather than implied.
- A genuine broad price move still raises the adopted rate, because the cap tracks p90. A move in a single
  endpoint above the cap now reports instead of repricing the reservation.
- The distribution is recorded per axis, so a drift issue can show the distribution of the reading that was
  adopted, and the outlier is visible when it appears.
- Detection remains the scheduled `Price Drift` workflow (ADR 0070). Nothing here puts a live assertion back into
  the unit suite.
- The cap can be wrong for a deployment that really is routed to the outlier. That deployment sets the override,
  which is what the override is for.
