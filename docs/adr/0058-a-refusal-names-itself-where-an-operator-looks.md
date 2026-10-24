# 0058 — A refusal names itself where an operator looks

- **Date:** 2026-10-24
- **Status:** Accepted

## Context

On 2026-10-24 a cost-governed deployment refused every turn that needed a model call. The
factory reported it as `MODEL_SELECTION_FAILED`, which reads as a model id, provider credit or
deployment-variable fault. None of those were wrong. The budget row was at 98% of its ceiling,
held by 27 reservations no process had settled (ADR 0054's leak, scheduled in ADR 0057).

The reason was only discoverable by querying `df_cost_budgets` by hand, because of three gaps
in the refusal path:

1. The deployed agent's gate threw a **bare `Error`**. A caller could not read `error.reason`;
   the reason lived only inside a string, so nothing could branch on it.
2. `decision.error` — the store's own message, for example *"Reservation would exceed the
   configured budget cap."* — was **dropped**. The one sentence that named the cause never left
   the gate.
3. **Nothing logged.** The refusal reached the runtime as an anonymous throw, so the deployed
   function's logs carried no line an operator could find.

The runner path was already diagnosed: it records the machine-readable code on the run and
throws a typed error. The deployed-agent path, the one that failed, was not.

## Decision

**One typed refusal, carrying the whole decision.** `CostRefusedError` lives in
`cost-governor.ts`, the module that owns the refusal union and produces the decision. It carries
`reason`, `period`, `category`, `tenantId` and `storeError` as fields, and its message renders
them so the string form stands on its own. `cost-gate.ts` throws it, populated from the
decision; `governed-agent-call.ts` re-exports the one class instead of declaring a narrower
duplicate.

**The gate narrates the refusal once.** `createCostGate` accepts an injectable
`log?: (message: string) => void`, defaulting to `console.warn`, and emits one line in the
existing convention:

```text
[dark-factory] cost gate refused the call category=orchestrator period=2026-10 reason=budget_exceeded store="Reservation would exceed the configured budget cap."
```

That line lands in the deployed function's runtime log — the surface an operator already reads.
The sink stays injectable so a later change can route it to a structured logger without touching
the gate.

**Warning level, not error.** A refusal is the control doing its job: the gate refused before
the provider was called, which is the intended outcome. Warning level keeps the error channel
meaningful. If refusals should raise to error level, that is a one-line change to the default.

## Consequences

- A refusal is self-describing on the thrown error and in the log. The next incident is a single
  search for `cost gate refused`, not a database query.
- **Eve owns the eval-side code.** `MODEL_SELECTION_FAILED` is emitted by the runtime when a
  dynamic resolver throws; nothing in this repository can change what `eve eval` prints. The
  acceptance for #458 is met on the run ledger (runner path) and in the structured log line
  (deployed-agent path), not by rewriting Eve. Making the eval code honest is an Eve-side change.
- The leading words of the message are kept, so the existing assertion
  `rejects.toThrow(/developer cost gate refused/)` and both `toBeInstanceOf(CostRefusedError)`
  cases still pass. The change is additive to the message.
- One line per refusal, and a refused turn stops, so refusals are rare and self-limiting by
  construction. No new module and no new environment variable, so the docs catalog and the
  `.env.example` coverage guard are untouched.

## Alternatives considered

- **Throw a custom error only from the gate and leave the duplicate in the call module.** Two
  classes named `CostRefusedError` would make `toBeInstanceOf` depend on which path threw —
  exactly the ambiguity this ADR removes.
- **Log at the call site instead of the gate.** The deployed agent's `step.started` handler has
  no run to record on, and the gate is the only place that holds the decision before the throw.
- **Log at error level.** Rejected for the reason above; a deliberate refusal is not an
  application error.
- **Encode the reason into the thrown message only.** Rejected: a message is not a field. The
  whole defect was that a caller could not read the reason without parsing text.
