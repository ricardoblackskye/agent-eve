# Price ceilings: what the reservation is a bound over

Every call the Dark Factory makes is reserved against **before** it runs, and trued up when it settles (ADR 0027).
The figure reserved is the *ceiling* for that model. This page records where that figure comes from, what keeps it
current, and what it deliberately does not cover.

## Why the dearest provider, and not the median

A model is served by many providers, and a call can be routed to any of them. Reserving the median would look
cheaper and then breach at settle. Both failure modes are real, and they are not symmetrical:

| | What it costs | How it shows up |
| Reserved above the rate | A temporary hold on budget that is released at settle | A run refused a slot it could have afforded |
| Reserved below the rate | A breach that is only discovered after the call is paid for | Budget consumed with no admission decision behind it |

Over-reserving is transient; under-reserving is not. That is the whole argument for reserving dearest.

## "Dearest" means within the peer distribution (ADR 0079)

Until ADR 0079 "dearest" was the single highest endpoint in the catalog, and one endpoint could set the number.
Measured live, the distribution for the default model looks like this:

| Date | Providers | Median | p90 | Second-dearest | Dearest | Dearest vs median |
| 2026-10-27 | 41 | 0.00084 | 0.0012 | 0.0024 | 0.015863057 | 18.9x |
| 2026-10-29 | 41 | 0.00084 | 0.0012 | 0.0018 | 0.0024 | 2.9x |

On 2026-10-27 a single endpoint charged an order of magnitude above every peer, so the ceiling was raised to
0.02 to cover it. That endpoint has since left the catalog, which left 0.02 reserving **8.3x** what any reachable
provider charges.

The refresh path now adopts a rate **capped at 3 x p90** and reports any provider above the cap instead of
reserving against it. The multiple is a derived figure, not a convenient one: on 2026-10-29 the cap works out at
0.0036, which leaves that day's dearest (0.0024) untouched and would have bound against the 0.015863057 above.

**What the cap does not cover:** a call actually routed to a far outlier can exceed the reservation. That is the
deliberate trade recorded in ADR 0079. A deployment that knows it is routed to an expensive endpoint should set
the override.

## Keeping it current

| | |
| `npm run prices:check` | Reads the live catalog, adopts the capped rate, and reports the distribution |
| `npm run prices:check -- --write` | Also rewrites the observation in `agent/lib/dark-factory/model-price-floor-data.ts` |
| `Price Drift` workflow (ADR 0070) | Runs the check daily, and opens or updates an issue when a ceiling no longer covers |

The workflow is deliberately *not* named "Unit Tests", so the branch ruleset cannot gate on a live catalog read.
Nothing in the unit suite reaches the network: the drift is caught on a schedule instead.

The writer refuses to record an observation a shipped ceiling does not cover, so a rise cannot be recorded while
the ceiling stays behind it. That refusal is what forces the ceiling to be revisited rather than quietly drifting.

## The distribution is recorded, not just printed

The observation carries the median, p90, second-dearest and provider count for each axis, so a drift issue can
show the distribution of the reading that was adopted rather than only the number it produced. An outlier is
therefore visible at the moment it appears, instead of being reconstructed from a later investigation.

A reading the rule declined is recorded separately as `declinedDearestUsdPer1k`, and its absence is meaningful:
it means the dearest was adopted as-is, which is the normal case.

## When the rule is wrong

`DF_MODEL_PRICE_<stableId>` overrides the table for the deployment that sets it, and still wins over everything
here (ADR 0027). The ceiling exists so that a model nobody has configured is still bounded; a deployment with
better information should use it.
