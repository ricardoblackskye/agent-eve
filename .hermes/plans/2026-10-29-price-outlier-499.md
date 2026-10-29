# 499 - the reservation must not be set by one outlier provider

**Goal:** stop a single provider setting the reservation an order of magnitude above its peers, while a genuine
broad price move still raises the ceiling, and make the provider distribution visible at the moment an observation
is adopted rather than discovered later.

**Approach:** report the distribution first (it is already fetched and thrown away), then bound what the refresh
path is allowed to adopt, then record the rule in an ADR. The reservation stays an upper bound - what changes is
which upper bound it trusts.

---

## Verified findings

| where                                      | what                                                                                                                                                                                 |
|--------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `scripts/openrouter-check-prices.ts:68-84` | every provider rate is fetched, then **discarded**: only `Math.max` per axis and a provider COUNT survive. This is exactly the acceptance criterion about reporting the distribution |
| `model-price-floor-data.ts:28-32`          | the committed observation still carries the outlier: `outputUsdPer1k: 0.015863057`, `verifiedAt: 2026-10-27`                                                                         |
| `cost-budget.ts:110`                       | the shipped ceiling is `outputUsdPer1k: 0.02`, raised to cover that outlier                                                                                                          |
| `model-price-floor.ts:232`                 | `ceilingsBelowObserved` is one-directional: a ceiling *below* the observation fails the build; nothing notices a ceiling far *above* it                                              |
| ADR 0027                                   | defines every table entry as the **dearest published provider price** - the definition this issue asks to change                                                                     |
| ADR 0070, 0071                             | the schedule and the floor. 0071 re-affirms "dearest" (the higher of table and observation), so this issue **amends** that definition rather than superseding the mechanism          |

### Measured live for this plan (2026-10-29, `deepseek/deepseek-v4.1-flash`, 41 providers)

| reading                 | value                                      |
|-------------------------|--------------------------------------------|
| median                  | 0.00084                                    |
| p90                     | 0.0012                                     |
| second-dearest          | 0.0018                                     |
| MAX                     | **0.0024** (BaseTen)                       |
| dearest vs peers        | 1.3x second-dearest, 2.0x p90, 2.9x median |
| within 2x of the median | 39 of 41                                   |

**The outlier has gone.** On 2026-10-27 the maximum was `0.015863057` (OpenInference) - 18.9x the second-dearest.
Today the maximum *is* that day's second-dearest. So the ceiling raised to cover it now reserves **8.3x** the
dearest provider that still exists: the over-reservation the issue predicted has since come to pass, and it is
still shipped.

## The two failure modes, and why one rule has to answer both

- **Adopt the maximum forever** risks over-reserving, and it is not hypothetical: the ceiling sits at 0.02 today
  against a real dearest of 0.0024. ADR 0027 calls over-reserving "transient", which is true of a single call and
  false of the ceiling itself - it was raised for a provider that has since vanished, and nothing lowers it.
- **Ignore the maximum** re-opens ADR 0027's risk: a call routed to the outlier can cost 18x the reservation, and
  the cap is passed with the money already spent.

A rule that keeps the reservation an upper bound while refusing to let one endpoint define "the market" is
therefore the shape, and the price of it must be stated: the bound is over the *peer* distribution, so a call
actually routed to a far outlier can exceed the reservation. That is the trade the issue's option 1 proposes, and
the ADR has to say so rather than imply the cap is free.

**One honesty point about the recorded number.** The observation takes the maximum per AXIS independently
(`:82-83`), so today's record pairs BaseTen's output with an input rate from another provider. It is a valid
per-axis bound and it is not a rate any single provider charges; the plan keeps that behaviour, and the
distribution report is what makes it legible.

## Global constraints

- **The reservation stays an upper bound over a stated population.** Whatever is adopted must be described in one
  sentence an operator can check against the catalog.
- **Fail closed on an unreadable catalog, a missing model, or a ceiling below the observation** - the existing
  refusals stay exactly as they are.
- **The record is still what was SEEN, dated.** Reporting the distribution must not turn the file into a live
  mirror of the catalog; the report is of one reading at one time.
- **A constant must be derived from data, not chosen for convenience.** The multiple has to be justified against
  the readings in this plan, both the one it would bind on and the one it must leave alone.
- **The committed file stays generated.** Any new field is rendered by `renderPriceFloorModule`, so the writer and
  the reader cannot disagree, and the byte-for-byte render test keeps covering the new shape.
- No new dependency, no secret in any output.

## Review focus

- **The rule must be inert on today's data.** With the multiple chosen below, the current reading must be adopted
  unchanged; a rule that binds when no outlier exists is a different defect with the same symptom.
- **A broad move must still raise the ceiling.** The bound has to move with the peer distribution, not sit at a
  fixed number - assert a synthetic catalog where every provider doubles.
- **The distribution must be reported for the reading that was ADOPTED**, not recomputed later, or the record and
  the report can describe different observations.
- **Do not weaken the under-reserve guard** while adding the over-reserve awareness. Both directions must be
  assertable, and the existing refusal tests must keep passing untouched.
- **The alert must not become a merge gate.** The drift workflow is deliberately not named `Unit Tests` (ADR 0070);
  nothing added here may reintroduce a live assertion into the unit suite.

## Tasks

### Task 1 - report the distribution (acceptance criterion 4)

**Files:** `scripts/openrouter-check-prices.ts`, `agent/lib/dark-factory/model-price-floor.ts`,
`tests/dark-factory/model-price-floor.test.ts`.

Keep the rates instead of reducing them to a maximum: compute the median, p90, the second-dearest and the ratio of
the dearest to its peers, print them in the refresh output, and carry the summary into the record so a drift issue
can show it. RED: the record renders the new field; a catalog with one far outlier reports the ratio.

### Task 2 - bound what is adopted (acceptance criteria 1 and 2)

**Files:** same module and script, `tests/dark-factory/model-price-floor.test.ts`.

The adopted rate is capped at the chosen multiple of p90; a provider above the cap is reported as an outlier rather
than setting the reservation. RED: the recorded 2026-10-27 catalog adopts the capped value and names the outlier;
today's catalog is adopted unchanged; a catalog where every provider doubles still raises the adopted rate.

### Task 3 - the ADR (acceptance criterion 3)

Amend 0027's definition of "dearest" in a new record: what the reservation is a bound over, what happens to a
provider above the cap, and the cost of the trade in the same sentence as the benefit.

### Task 4 - the measured proof

Re-run the refresh against the live catalog and report the numbers: the distribution, the adopted rate, and whether
anything was capped. Include the 2026-10-27 counterfactual - the recorded catalog under the new rule - so the proof
shows the rule binding where it should and staying inert where it should.

### Task 5 - the ceiling reset, if agreed

The shipped ceiling is 0.02 against a real dearest of 0.0024. If decision 4 goes that way, lower it to the capped
rule's value and refresh the observation, so the shipped pair are consistent with each other and with the catalog.

---

## Validation

- Full suite green with no new failures, `tsc --noEmit --incremental false` clean, and cspell (the version CI pins),
  markdownlint and the table formatter over **every** changed file, committed and working-tree.
- **The Postgres legs must RUN**: export the five `DF_*_TEST_DATABASE_URL` variables.
- The live refresh is the only network step and stays out of the unit suite.

## Decisions (agreed at GATE 1)

1. **The rule** - cap the adopted rate at a multiple of p90 and report a provider above it, rather than adopting it
   (recommended: the issue's own option 1, keeps "dearest" meaningful and fails loudly) versus a high percentile in
   place of the maximum (simple, but arbitrary and abandons "dearest" as the contract) versus reporting only and
   still adopting the maximum (safest against under-reserving, keeps the treadmill and today's 8.3x
   over-reservation).
2. **The multiple** - **3x p90** (recommended, and derived: today p90 is 0.0012, so the cap is 0.0036, which is
   *inert* against today's 0.0024 and would have *bound* the 0.015863057 outlier) versus 2x the second-dearest
   versus 5x p90 (looser, and it would still have bound the outlier, but it tolerates a wider spread before saying
   anything).
3. **Where the distribution lives** - recorded in the generated observation as well as printed (recommended: a
   drift issue can then show the distribution of the reading that was adopted, and the guard can assert it) versus
   printed only, leaving the record with a count.
4. **The shipped ceiling now** - lower it from 0.02 to the capped value (~0.0036) in the same change (recommended:
   the outlier is gone and we are over-reserving 8.3x, which the issue names as its own harm) versus leave 0.02 as
   deliberate headroom and change only the rule.
5. **The ADR** - a new record amending 0027's definition of dearest (recommended, matching how 0070 and 0071
   already amended it) versus rewriting 0027 in place, which would erase the decision the current numbers came
   from.
