# Cost estimation: how each figure is computed

Four cost figures are computed during a Dark Factory run, and all four are the same arithmetic:
**tokens divided by 1,000, multiplied by a price per 1,000 tokens**. They differ in three ways only —
which token counts they use, when they run, and whether they have any authority over the run.

This page covers each figure, the shared price source, and the part that is easy to assume wrongly:
**what the token counts are actually derived from**. It is much less than "the size of the change", and
that is worth knowing before trusting a band.

## The one formula

```text
usd = (tokensIn / 1000) * inputUsdPer1k  +  (tokensOut / 1000) * outputUsdPer1k
```

## The price source — one table, shared by every figure

Where those ceilings come from, what keeps them current, and what they deliberately do not cover: see
[Price ceilings](dark-factory-price-ceilings.md).

[`cost-budget.ts`](../../agent/lib/dark-factory/cost-budget.ts) owns the only price lookup,
`resolvePrice(model)`, and every figure below goes through it. A plan estimate therefore cannot
disagree with a reservation about what a token costs.

Resolution order:

1. `DF_MODEL_PRICE_<stableId>` — an operator override, `"input,output"` per 1k. An operator who knows
   which provider is in use can pin an exact rate.
2. The built-in `modelPriceTable`. These are **reservation ceilings, not rates**: the dearest published
   provider price for the model, never the headline `/models` figure, because a model's published price
   differs per provider (up to ~14x for one of these). See
   [ADR 0027](../adr/0027-model-prices-are-reservation-ceilings.md).
3. `null` — an unpriced model. A **call** is then refused outright (`unpriced_model`); a **plan band**
   falls back to the dearest rate in the whole table, because costing an unknown model at zero would
   make an expensive run look free.

The table is also raised, per axis, to the observed-dearest verified rate
([`model-price-floor.ts`](../../agent/lib/dark-factory/model-price-floor.ts)) — the higher of the
hand-maintained ceiling and what was actually observed wins.

## The four figures

| figure               | input tokens                 | output tokens           | authority                         |
|----------------------|------------------------------|-------------------------|-----------------------------------|
| Per-call reservation | `ceil(promptChars / 4)`      | **8,000 flat**          | fail-closed — can refuse the call |
| Settled actual       | provider-reported usage      | provider-reported usage | true-up after the call            |
| Plan band            | `min(files, 24) * 3,000 * 2` | `8,000 + tasks * 2,000` | advisory only — no authority      |
| Ledger and caps      | aggregates the above         | aggregates the above    | the cap check                     |

## Figure 1 — the per-call reservation

Where: [`cost-gate.ts`](../../agent/lib/dark-factory/cost-gate.ts) and
[`cost-governor.ts`](../../agent/lib/dark-factory/cost-governor.ts) (`admit`).

Before a model call, the governor is asked to admit it. It refuses on any of: no cap configured for the
category, an unpriced model, an unprovisioned tenant, an unavailable store, or an estimate that would
push `spent + reserved` past the cap. Otherwise it reserves.

The estimate is `estimateCost(model, ceil(promptChars / 4), 8_000)`: the prompt the runner has just
built, divided by four, plus a flat 8,000-token output ceiling. At the current rates for the default
model that means:

```text
prompt   2,000 chars ->   500 in-tokens + 8,000 out = $0.1603 reserved
prompt 130,236 chars -> 32,559 in-tokens + 8,000 out = $0.1828 reserved
prompt 288,000 chars -> 72,000 in-tokens + 8,000 out = $0.2104 reserved
```

Note the shape: **the flat output ceiling dominates**, so any call reserves at least ~$0.16 regardless
of prompt size, and a 24x bigger prompt moves the reservation by only ~$0.05. That is deliberate — the
number being reserved must be an upper bound, because it is what the cap is checked against, and
under-reserving lets a cap be passed before anything reconciles.

## Figure 2 — the settled actual

Where: [`governed-model.ts`](../../agent/lib/dark-factory/governed-model.ts) (`withSettlement`) and
`settleFromUsage` in `cost-gate.ts`.

The model is wrapped, so when the call finishes the **provider's own usage** is read off the result (or
the stream's `finish` part), pushed back through the same formula and the same price, and settled:
`spent += actual`, `reserved -= reservation`. This is where the reservation's approximation is replaced
with a measurement. See
[ADR 0054](../adr/0054-a-reservation-is-settled-where-the-call-happens.md).

Two fail-safe choices matter here. An **unpriced** model settles `null` rather than `0`, and a call that
**throws** settles `null` — both leave the reservation charged, because releasing budget for a call that
ran is the dangerous direction.

## Figure 3 — the plan band

Where: [`plan-cost-estimate.ts`](../../agent/lib/dark-factory/plan-cost-estimate.ts). It is a **band**,
not a point, because measured run-to-run variance is large (see
[ADR 0069](../adr/0069-plan-cost-estimates-are-advisory-bands.md)).

```text
contextFiles = min(targetFiles.length, 24)          # mirrors the Architect's bounded reader
inputTokens  = contextFiles * (12,000 / 4) * 2      # two reads: architect plans, developer implements
outputTokens = 8,000 + tasks * 2,000
base         = tokens / 1000 * rates
expected     = base * max(1, mean(iterations + fixCycles + 1) over prior runs)
band         = [expected * 0.5, expected * 2]
class        = XS < $0.25 <= S < $1 <= M < $5 <= L < $20 <= XL   # an edge lands in the UPPER class
confidence   = low (no history) | medium (< 10 samples) | high (>= 10)
```

The function is pure — no clock, no network, no randomness — so a test pins the band exactly. Worked
examples, produced by calling the shipped function:

```text
 1 file /  1 task -> $0.10 - $0.41  (expected $0.2042, class XS)  in=  6,000 out=10,000
 3 files/  4 tasks -> $0.17 - $0.67  (expected $0.3326, class S)   in= 18,000 out=16,000
24 files/  4 tasks -> $0.21 - $0.84  (expected $0.4208, class S)   in=144,000 out=16,000
24 files/ 20 tasks -> $0.53 - $2.12  (expected $1.0608, class M)   in=144,000 out=48,000
unknown model      -> $0.11 - $0.43  (priced at the table's dearest rate)
```

The first row is worth pausing on: `$0.10 - $0.41` is the band that appeared on a real issue, reproduced
from the formula.

## Figure 4 — the ledger and the caps

The same numbers are persisted: usage events carrying tokens and an optional `costUsd`, `run.cost`
events on the run, and the budget rows (`spent_usd`, `reserved_usd`, `call_count`) that the caps read.
The cap check is against **`spent + reserved`**, which is why the reservation has to be a ceiling. The
policy half of this lives on [Cost and usage governance](flow-cost-governance.md).

## How the inputs are arrived at — and what is not used

This is the part that deserves to be explicit, because the natural assumption is wrong.

**The estimator never looks at the repository, the diff, or the change.** It reads exactly two integers
out of the plan:

- `plan.targetFiles.length` — the files the Architect listed. Each entry is `{path, action, rationale}`
  ([`plan-validator.ts`](../../agent/lib/dark-factory/plan-validator.ts)); **there is no size field**.
- `plan.tasks.length` — the tasks the Architect listed, each `{title, objective, files[], steps[],
  verification}`. **There is no effort, size or LOC field either.**

Everything else is a fixed constant from the same module:

- Every target file is charged the **maximum** read (`MAX_CHARS_PER_FILE = 12,000` chars → 3,000
  tokens). The file's actual size is never consulted, so a 20-line stylesheet and a 3,000-line module
  cost the same.
- That read is multiplied by `CONTEXT_READS_PER_RUN = 2` — a structural working assumption, not a
  measurement.
- Files are capped at `MAX_CONTEXT_FILES_READ = 24`, so input tokens saturate at 144,000 no matter how
  large the repository is.
- Output is `8,000` (planning) plus `2,000` per task.

So to answer the obvious questions directly:

| question                         | answer                                                                                                                                                                                                                                                                           |
|----------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Lines of code that will change?  | **No.** LOC is never counted. The only line counting in the codebase is [`preservation-guard.ts`](../../agent/lib/dark-factory/preservation-guard.ts), which measures removed lines on the developer's diff *after* the change, as a safety guard — it is not an estimate input. |
| Complexity of the code?          | **No.** The only "complexity" in the factory is an AMM readiness checklist signal — a static-analysis rule for repository health, unrelated to cost.                                                                                                                             |
| How is the repo involved at all? | Indirectly. The **Architect** reads the repo and turns it into a plan; the **estimator** consumes that plan's shape. The repo influences the estimate only through how many files and tasks the model decided the change needs.                                                  |

Two consequences follow. First, **"complexity" enters solely through the plan's decomposition** — the
model's judgement about how many files and tasks the work has. Two plans with the same file and task
counts produce byte-identical bands even if one is a one-line copy change and the other is a rewrite.
Second, the band is **near-constant for small stories**, which is exactly what the real comments show.

### Two real measurements exist, and neither is wired in

- The Architect's bounded reader records `stats(): { filesRead, totalChars }`
  ([`architect-agent.ts`](../../agent/lib/dark-factory/architect-agent.ts)) — the *true* context size it
  actually ingested, which is precisely the quantity the estimator guesses at with
  `min(files, 24) * 12,000 * 2`. **No non-test caller reads it.** Wiring it would replace a guess with a
  measurement for the dominant input term.
- The settled usage from Figure 2 is a measured actual per call. Nothing feeds those measured costs back
  into the plan estimate yet; that is the calibration path, tracked as **#490**.

### The estimator now reads repository history

`confidence` and `revisionFactor` are no longer constants: the window is chosen by
[`plan-history.ts`](../../agent/lib/dark-factory/plan-history.ts). The estimate is calibrated against the
repository's **finished** runs — `succeeded`, `failed` or `aborted`, newest first, capped at 20 — which the
runner reads from the store it already holds and hands in, since the estimator is pure and cannot read one
itself. A `blocked` run is a park rather than an outcome, so its counters are excluded; failures are
included, because a failed run's revision counts are the thrash the factor exists to capture.

The estimator's version therefore moves to **v2**: no constant changed, but the same plan now yields a
different band for a repository with history, and the stamp is what keeps those two regimes apart in the
ledger. See ADR 0077.

### The one learned input is also not wired

`revisionFactor` is the only empirical term: `max(1, mean(iterations + fixCycles + 1))` over prior runs,
which raises the band by the average number of revision rounds a task of that kind has needed. But the
runner calls the estimator with no `history`, so in production it is always `1` and `confidence` is
always `low`. The recorder accepts a history; nothing supplies one yet.

## What this means in practice

- Treat the plan band as **a statement about the plan's shape**, not about the change's size. It is
  useful for spotting a plan that has ballooned into 20 tasks or 24 files, and it is not useful for
  distinguishing a trivial edit from a substantial one.
- Trust the **reservation** more than the band: it prices the prompt that was actually built, so it
  moves with the evidence the run really read.
- Trust the **settled actual** most. It is the provider's own token counts at the shared price.
- The band is diagnostic only — it never blocks anything. The gate is the authority.

## The calibration report

The band is checked against what runs actually cost by
[`calibration-report.ts`](../../agent/lib/dark-factory/calibration-report.ts), driven by
[`scripts/df-calibration-report.ts`](../../scripts/df-calibration-report.ts)
(`npm run df:calibration-report`). It leads with **signed bias** — the mean of `estimate - actual`, so
a positive figure means the estimator was HIGH — then MAE and MAPE, broken down by stage and by cost
class, and it emits the multiplicative factor `mean(actual / estimate)` that the estimator consumes in
v2.

Two properties matter more than the arithmetic:

- **The actual is the run's recorded usage**, summed from the usage ledger per run and per stage. It is
  deliberately NOT read from the accuracy view, whose actual column joins
  `df_run_summaries.cost_usd` and is NULL on every run recorded so far. See ADR 0074.
- **Below the minimum sample size nothing is published.** `DF_CALIBRATION_MIN_SAMPLES` (default 10)
  governs it; under that threshold the report prints the counts and withholds every figure, so a small
  window cannot be read as a measured zero.

A stage with no recorded actual is reported as `measured: false` and carries no bias at all, rather
than being compared against a zero that reads as a measured overshoot. The sandbox's spend — which is the
developer's — reaches the ledger because the gateway measures the calls it pays for and records them
typed `developer`; a deployment without a usage driver records nothing, and the report says so.

The run's actual is therefore **the ledger's total alone**. The run summary reads that one source, and the
writer REPLACES the row's cost rather than adding to it, so a figure can never be counted twice — see
ADR 0076, which supersedes ADR 0075's two-source rule.

## The run's actual cost

The run summary's `cost_usd` — the column the accuracy view joins on — is written by
[`run-cost-recorder.ts`](../../agent/lib/dark-factory/run-cost-recorder.ts), which reads what a run
recorded and sums it with the one definition in
[`run-actual-cost.ts`](../../agent/lib/dark-factory/run-actual-cost.ts): the usage ledger for the
in-process governed calls (tester excluded, matching the estimator's scope), plus the run's own
`run.cost` events, which the deployed gateway writes. See ADR 0075.

Two properties are deliberate. The write is a **narrow, single-column update**, so recording a cost
cannot clobber a concurrent status change; and it is **best-effort**, so a ledger hiccup is reported and
logged rather than failing a run — a run record fails closed, its bookkeeping does not. When NEITHER
source recorded anything, nothing is written: the run stays unmeasured rather than reading as free.

## Where calibration goes next

The constants above are labelled in the source as structural working numbers, and the two band
multipliers as placeholders. Replacing them with measured estimate-versus-actual pairs, and wiring the
Architect's real `totalChars`, is **#490**.
