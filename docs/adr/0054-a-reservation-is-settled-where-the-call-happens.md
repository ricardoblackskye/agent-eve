# 0054 — A reservation is settled where the call happens, and a reaper covers the rest

- **Date:** 2026-10-23
- **Status:** Accepted

## Context

The cost gate reserves budget before a model call is made. `governor.admit()` returns a
`reservationId`, and the store increments `reserved_usd` against the cap. The reservation is only
released when someone calls `settle()`.

On the agent path nobody did. `buildGovernedDynamicModel` called `gate.admit()` and discarded the
result, so the reservation id was lost and `reserved_usd` grew on every turn. The production row
showed the shape of it plainly:

```text
2026-10 | orchestrator | cap=30 | spent=0 | reserved=4.855392 | call_count=0
```

`spent = 0` and `call_count = 0` next to a live `reserved` means no call was ever settled while at
least one was admitted. A second row carried a reservation equal to its whole ceiling. The ceiling
erodes silently, and a legitimately refused call cannot be told apart from a leaked one.

Two constraints make this structural rather than an oversight:

1. **The model resolver has no completion event.** Its scopes are `session.started`, `turn.started`
   and `step.started`. There is no point at which we observe that the call finished.
2. **The framework owns the call.** After `step.started` returns, the provider call is eve's, so no
   `finally` of ours wraps it.

The pre-call gate cannot settle what it cannot observe. Something else has to.

## Decision

Three parts, each covering a case the others cannot.

**A — Settle at the call boundary by wrapping the returned model.** `step.started` may return a live
`LanguageModel`, so the gate hands back a wrapper that delegates to the real model and settles
around `doGenerate` / `doStream`. A completed call settles to its measured usage, priced by the
shared table. A call that throws settles at the estimate and rethrows untouched. A streamed call
settles from the `finish` part once the stream is read to its end; a stream that errors settles at
the estimate.

**B — Reap reservations that cannot be settled.** A process killed mid-call, a deployment swap or a
platform timeout runs no code, so no wrapper can settle. A reservation past a TTL is released by the
store. This is the backstop A structurally requires. The TTL is a guess and is stated as one: too
short reaps live calls and lets a slow turn over-spend; too long leaves budget stranded.

**C — Count the call at admission.** `call_count` increments when the reservation is taken, not when
it settles. The row then shows that a call was admitted even if nothing ever reconciles it. Without
this, `call_count = 0` next to a live `reserved` actively hid the condition.

### What each outcome settles to

| outcome | settles to | why |
|---|---|---|
| completed, usage measured | actual cost | the truth |
| ran, usage unavailable | the estimate | an upper bound is required; never released as though the call were free |
| never reached the provider (admission refused, request failed early, reaped stale) | released, counted | no tokens were consumed; charging the full bound makes the ceiling lie in the other direction |

## Consequences

- The reservation travels with the model, so the wrapper is on the hot path of every step. It must
  not change streaming behaviour or swallow a provider error; the tests pin both.
- A settlement that fails still leaves the reservation for the reaper. Failing closed is the intended
  direction for a money control.
- An unpriced model settles `null`, not `0`: settling zero would release budget for a call that did
  run. The price table remains the authority on what a call costs.
- The cap check itself is untouched. The change makes the ceiling truthful, never looser.
- A reaped reservation stays visible as a counted call with no charge, so runaway retries remain
  observable instead of being silently forgotten.
