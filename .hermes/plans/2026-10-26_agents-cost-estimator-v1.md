# Agents Cost Estimator — V1 Implementation Plan (#453)

Epic: **#453 Agents Cost Estimator**
Sub-issues: **#484 – #490**
Branch: `feat/453-architect-cost-category`
ADR: **0069** (next free number; 0068 is taken by #473)

## 1. Goal

A Dark Factory run should state what it is likely to cost **before** a human approves the plan, in a
form honest about its own uncertainty. V1 delivers that as a **cost band and cost class**, recorded
against the `runId`, shown in the plan comment, and later compared with the run's actual cost.

This is an epic, not a single change. V1's primary value is **instrumentation**: it begins recording
estimate/actual pairs so a calibrated v2 becomes possible. The first bands will be wide and marked
low-confidence. That is the agreed behaviour, not a defect.

## 2. What the evidence changed about the original premise

The epic originally proposed deriving cost from an Architect "complexity analysis" mapped onto token
counts. The research pass found that premise weakly supported:

- Expert/LLM difficulty ratings correlate only weakly with actual token cost.
- Run-to-run variance on identical tasks is large — a point estimate would imply precision we do not have.
- Self-prediction by LLMs is systematically low; it is advisory at best.
- Hidden-state methods are unavailable: the API is closed, so there are no internal states to regress on.
- Accuracy peaks at *intermediate* cost levels, not uniformly.

Consequences baked into this plan: **bands not numbers**, **input-side features**, the Architect's
complexity rating demoted to one weak feature among several, and self-estimate stored as advisory only.

## 3. Scope

### In V1
- An `architect` cost category so planning spend is attributed and budgeted correctly.
- A pure estimator returning band, class, confidence and compact features.
- Persistence of the estimate against the `runId`.
- The estimate computed at plan time and shown in the **plan comment** (the human decision point).
- An ADR recording the decisions.
- Recording of estimate/actual pairs from day one.

### Out of V1
- **No gating.** The estimate is advisory; it never blocks or refuses a run.
- **No runs-ledger UI.** The plan comment is the only human surface in v1.
- **No Tester role** — deliberately excluded per instruction.
- **No Developer-stage estimate.** Architect-stage only in v1.
- **No calibration report in the v1 release.** Tracked as #490 and expected a release later; the pairs
  are recorded from day one so it has data when it lands.

## 4. Issues and dependency graph

| Issue | Title | Depends on |
|---|---|---|
| #484 | `chore(df): attribute architect planning to its own cost category` | — |
| #485 | `feat(df): pure plan cost-estimate module — band, class and confidence` | — |
| #486 | `feat(df): persist plan estimates against the runId` | #485 |
| #487 | `feat(df): compute the plan estimate when the architect produces the plan` | #485, #486 |
| #488 | `feat(df): show the cost band in the plan comment` | #486, #487 |
| #489 | `docs(df): ADR 0069 — plan estimates are bands, advisory only, calibrated from the ledger` | #485 |
| #490 | `feat(df): calibration report — signed bias first, then MAE per stage` | #488 (post-v1) |

```
#484 (attribution) ──┐
                     ├──> #487 (wire at plan time) ──> #488 (comment surface)
#485 (estimator) ────┤                                    │
                     └──> #486 (persistence) ─────────────┘
                                          └──> #489 (ADR)   [parallel, after #485]
                                                           └──> #490 [post-v1]
```

**#484 and #485 are independent** and can proceed in parallel. #485 is the critical path.
#489's ADR decision about the `architect` ceiling is needed before #484 merges, because the ceiling
choice changes deploy configuration.

## 5. Phase 0 — #484, the prerequisite, in detail

### The problem is worse than a mislabel

`scripts/dark-factory-runner.ts:442` builds the Architect's governed call with
`category: "developer"`. `COST_CATEGORIES` in `agent/lib/dark-factory/cost-budget.ts` is:

```ts
["orchestrator", "developer", "tester", "pr-review"]
```

There is no `architect`. Two distinct faults follow:

1. **Attribution** — architect planning tokens are indistinguishable from developer work in cost reporting.
2. **Budget** — architect planning spend is charged against the **developer's** ceiling. A planning-heavy,
   implementation-light run looks like an expensive developer run and can exhaust the wrong budget.

### The trap that makes the naive fix deploy-breaking

Adding `"architect"` to `COST_CATEGORIES` widens the union, which changes
`ResolvedCostBudgetEnv.categories` from `Record<CostCategory, number>`. That forces a key into
`createCostGovernanceEnv`, and `validateCostBudgetEnv` is **fail-closed** — it throws when a cap is
missing. So a naive change makes **every existing deployment fail to start** unless
`DF_COST_BUDGET_ARCHITECT_USD` is set. Separately, `cost-governor.ts:162-168` refuses an admitted call
with `not_configured` when a category has no cap, so even a runtime-only addition would fail-closed and
stop all planning.

### Resolution adopted (to be ratified in ADR 0069)

- `architect` joins `COST_CATEGORIES`.
- `DF_COST_BUDGET_ARCHITECT_USD` is read when present.
- **When absent, the architect cap defaults to the orchestrator cap.** This keeps deployments starting,
  gives planning a real ceiling, and does not silently leave a category unbounded. The default is stated
  in the ADR and logged at startup so it is never invisible.
- The runner's architect call uses `category: "architect"`.

### Known limitation to record honestly

Existing budget rows have already accumulated architect spend under `developer`. That history cannot be
cleanly re-attributed. After this lands, the developer row's historical total is overstated and the new
architect row starts at zero. The ADR records this; no retroactive migration is attempted.

### Acceptance criteria (#484)
- [ ] `COST_CATEGORIES` includes `architect`; `isCostCategory` accepts it.
- [ ] `DF_COST_BUDGET_ARCHITECT_USD` parsed; absent ⇒ defaults to the orchestrator cap (non-breaking).
- [ ] `validateCostBudgetEnv` still fails closed for genuinely invalid values.
- [ ] The architect's governed call uses `category: "architect"`.
- [ ] Architect spend does **not** count toward the developer ceiling.
- [ ] Other categories behave exactly as before — no new refusals.
- [ ] Tests: category validation; defaulting to the orchestrator cap; separate spend rows; developer
      ceiling unaffected by architect spend.
- [ ] Any new module under `agent/lib/dark-factory/` referenced from a `docs/pages/*.md` page.

## 6. Test strategy

- **Unit (#485):** band boundaries on both sides of every threshold; cold start; unknown model; zero and
  negative token guards; determinism (same input twice, same band).
- **Provider round-trip (#486):** sqlite *and* postgres; the absent-estimate case must read as absent,
  never `0`.
- **Integration (#487):** validate → estimate → persist → comment ordering asserted; a failed estimate
  leaves the run running.
- **Snapshot (#488):** the rendered comment, with and without an estimate.
- **Real run (#487/#488):** one real plan posted to a real issue. A unit test proves the function, not the
  wiring. This is the lesson from #309's outstanding AC1.

## 7. Risks

1. **The first band may be too wide to be useful.** With measured variance as high as 30x, a first
   structural estimate could return "M–XL", which tells a human nothing. If so, the honest response is to
   narrow the *class* and say the band is wide, not to fake precision.
2. **Cold start is most of v1.** Until pairs exist every estimate is structural and low-confidence. If the
   band proves unhelpful in practice, #490's calibration becomes urgent rather than optional.
3. **The migration in #486 is the least reversible step.** It should land in its own PR so a rollback does
   not drag the estimator with it.
4. **Ordering in #487 is load-bearing.** The estimate needs the *validated* plan, which is only available
   after validation — so validation must precede the comment. #487's PR must state the ordering it chose.
5. **Historical attribution skew** (section 5) — accepted and documented, not repaired.

## 8. Decisions carried in from the user
- Bands and cost classes, not exact numbers.
- Absolute thresholds anchored to the monthly orchestrator cap:
  XS < $0.25 · S $0.25–$1 · M $1–$5 · L $5–$20 · XL > $20.
- Cold start emits a structural-only band marked `confidence: low`.
- **Advisory only — never blocks.**
- Tester role excluded from v1.
- ADR uses the next free number: **0069**.
