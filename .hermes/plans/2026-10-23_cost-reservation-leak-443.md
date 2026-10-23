# 443 - cost-budget reservations taken on the agent model path are never settled

**Issue:** #443
**Branch:** `fix/cost-reservation-leak-443` (off `origin/main` @ `6547f66`)
**Status:** plan - awaiting GATE 1

## Goal

A reservation taken when a model call is admitted is settled in every outcome, so the effective
ceiling stops eroding and a legitimately-refused call can be told apart from a leaked one.

## Root cause, verified

`agent/lib/dark-factory/governed-model.ts:43-45`:

```text
"step.started": async () => {
  // The gate runs FIRST: a throw here fails the turn before any provider call is made.
  if (gate != null) await gate.admit();
  return { model: chatModel, modelContextWindowTokens: contextWindowTokens };
},
```

The result of `admit()` is **discarded**. The `reservationId` it returns is never captured, so no
caller could settle it even if one wanted to - the store's own documentation treats a reservation as
in-flight work (`cost-budget-store.ts:246` increments `reservedUsd`; `:236` mints the id).

Two constraints make this structural rather than an oversight:

1. **eve's model resolver has no completion event.** Its scopes are `session.started`, `turn.started`
   and `step.started` only (`node_modules/eve/docs/agent-config.md:82-86`) - there is no point at
   which we can observe that the call finished.
2. **eve owns the call.** After `step.started` returns, the provider call is eve's; our code is not on
   that path, so no `finally` of ours wraps it.

So the admission is a one-way door: the budget is reserved and nothing ever gives it back.

### Evidence from production `df_cost_budgets`

```text
budget_id,period,category,cap_usd,spent_usd,reserved_usd,call_count,updated_at,tenant_id
2026-10|orchestrator,2026-10,orchestrator,30,0,4.855392,0,2026-10-22T16:08:25.220Z,null
2026-02|tester,2026-02,tester,10,0,10,0,2026-10-04T12:17:21.637Z,null
```

`spent = 0` and `call_count = 0` with a live `reserved` means **no call has ever been settled** for
that category and period, while at least one was admitted. The `2026-02` tester row carries a
reservation equal to its whole ceiling.

### What is NOT broken

`runGovernedLlmCall` (`governed-llm-call.ts:55-70`) settles on both paths - measured cost on success,
the estimate in the `catch`. The runner script is fine. Only the **agent** path leaks, which is why
this was invisible from the runner and why the failure surfaced as `MODEL_SELECTION_FAILED` with no
budget detail.

## Intended fix

Three parts. The parts are separable, and the combination is the GATE 1 decision.

### A - Settle at the call boundary by wrapping the returned model

`step.started` may return a live `LanguageModel` (`agent-config.md:90-91`), so return a wrapper that
delegates to `chatModel` and settles around the real call (`doGenerate` / `doStream`), in a `finally`
so a throw still settles. Measured cost when the provider reports usage; the estimate when it ran but
usage is unavailable.

### B - Reap reservations that cannot be settled

A process killed mid-call, a deployment swap, or a platform timeout runs no JS at all, so no wrapper
can settle. A reservation past a TTL must be reaped by the store. This is the backstop the resolver
path structurally requires - A cannot cover it.

### C - Make an admitted-but-unsettled call visible

Increment `callCount` at admission, so the row itself shows that a call was admitted. Today
`call_count = 0` next to a live `reserved` actively hides the condition.

## Decision for GATE 1

**How much of A/B/C to ship?**

- **Option 1 (recommended): A + B + C.** The call is settled precisely where it can be; strays are
  reaped; the row tells the truth. Largest change, only one that closes the leak for both the
  ordinary and the killed-process case.
- **Option 2: B + C.** Smallest change that stops unbounded erosion - the leak is bounded by the TTL.
  The row stays wrong until the sweep runs, and an in-flight call is indistinguishable from a leak.
- **Option 3: A + C.** Precise in the common path, but a killed process still strands budget, and
  nothing reaps it.

**What should a call that failed settle to?** The store's existing rule is "never released as though
the call were free" (`cost-budget-store.ts:269`), which was written about a call that RAN but whose
cost could not be measured. Three cases deserve three answers:

| outcome                                                                                    | settle to                | why                                                                                                                                |
|--------------------------------------------------------------------------------------------|--------------------------|------------------------------------------------------------------------------------------------------------------------------------|
| completed, usage measured                                                                  | actual cost              | the truth                                                                                                                          |
| ran, usage unavailable                                                                     | the estimate             | existing rule; an upper bound is required by the price table                                                                       |
| never reached the provider (admission threw, request failed before the call, reaped stale) | release, `callCount + 1` | no tokens were consumed; charging the full upper bound makes the ceiling lie in the other direction, and the attempt stays visible |

Recommendation: ship Option 1 with the three-case table above. The third row is the one worth
arguing about - it trades a little over-spend protection for a truthful ceiling, and `callCount`
keeps runaway retries observable.

## Tasks (TDD)

1. **RED/GREEN:** `step.started` captures the reservation, and a successful call settles it to the
   measured cost; `reserved` returns to its prior value.
2. **RED/GREEN:** a call that throws still settles - the reservation does not survive the failure.
3. **RED/GREEN:** a reservation never reached at the provider is released and counted, not charged.
4. **RED/GREEN:** the store reaps a reservation past its TTL, per the table above, and leaves a
   fresh one alone. Includes the exact-boundary case (`age == TTL`).
5. **RED/GREEN:** `callCount` increments at admission.
6. **ADR 0054** recording the three-case settle policy and why a reserved-then-settled model needs a
   reaper (eve gives no completion event on the model path).

## Files likely to change

- `agent/lib/dark-factory/governed-model.ts` - capture the reservation, return a settling wrapper
- `agent/lib/dark-factory/cost-budget-store.ts` - reap, admission-visible `callCount`
- `agent/lib/dark-factory/cost-governor.ts` - expose what A and B need
- `tests/dark-factory/cost-budget-store.test.ts`, `cost-governor.test.ts`, `governed-llm-call.test.ts`
- new test file for the settling wrapper
- `docs/adr/0054-*.md` + `docs/adr/README.md`

## Validation

- `npx vitest run` on the Dark Factory cost suites, then the FULL suite (a contract change means the
  whole suite, not the focused files).
- `npx tsc --noEmit --incremental false` - Vitest strips types without checking them.
- cspell (`npx -y cspell@9.1.1 -c .cspell.json <changed files>`) and markdownlint on the ADR.
- The agent path is verifiable locally without an API key: `npm run eve:build` with the gate variable
  unset and set, then `npx eve invoke "<prompt>"` (mock model) and confirm the reservation is settled
  by reading the store back.

## Risks and open questions

- **Wrapping the model touches the hot path.** A proxy in front of every step must not change
  streaming behaviour or swallow a provider error; the wrapper must rethrow untouched.
- **`doStream` settlement is the hard case.** A stream can fail after tokens are consumed; settling at
  stream end is not the same as settling at stream start. Task 2 must cover a mid-stream failure.
- **TTL choice is a guess and must be stated as one.** Too short reaps live calls and lets a slow turn
  over-spend; too long leaves budget stranded. The ADR must record the value and the reasoning.
- **This is a money control.** The change must not make admission easier or the cap looser; every task
  keeps the existing cap check at `cost-budget-store.ts:228` untouched.
- **The `2026-01` / `2026-02` rows are test data** from a period override and are not evidence of a
  second bug; they should be cleaned up rather than modelled.

## Out of scope

- #405 (the Architect planning against the runner's cwd) and #400 (the model contract), both separate.
- The cost gate's own configuration, and any environment change - this is store and resolver logic.
