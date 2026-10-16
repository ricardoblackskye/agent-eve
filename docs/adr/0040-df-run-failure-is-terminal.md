# 0040 — Any post-acceptance failure ends the run terminally

- **Date:** 2026-10-16
- **Status:** Accepted

## Context

One active run per repo+issue holds a CLAIM, taken by `status IN ('queued','running','blocked')`
and released by the terminal event a run writes when it ends. A run that stops without that
event leaves the ticket on `df:running` and the ledger holding a claim no later attempt may
adopt, because a resume adopts only a `blocked` holder and a fresh dispatch is refused as a
duplicate delivery.

The runner applied the terminal lifecycle in its coding-phase catch for a `CircuitTrippedError`
ONLY. Every other failure escaped to the top-level `main().catch`, which logs and sets an exit
code and does nothing else. The first sandbox-backed push failed on TLS verification (0039) and
left exactly that state: `-> Cleared: df:done, df:failed` and then no `df:failed`, with the
ledger's newest row `status=queued stage=trigger`. The authored work was gone with it, because
`runCodingPhase` disposes the sandbox in a `finally`.

## Decision

- The terminal lifecycle is applied for ANY error escaping the coding phase, not only a trip:
  the ticket is labelled `df:failed` and the run's ledger row is driven terminal, which releases
  the claim.
- The breaker-trip RECORDING stays gated on `CircuitTrippedError`. Explaining a trip on the run
  and ending any run are different obligations, and only the first is trip-specific.
- The failure path is EXTRACTED into an exported `finalizeCodingPhaseFailure`. It lived inside
  `main`, which no test can call — and untestable is why the defect survived a suite that simply
  could not reach the line.
- A failure BEFORE the run is accepted is out of scope: there is no claim to release, and
  accepting the delivery is what creates the record.

## Consequences

- A failed run is always explainable on the ticket and never holds a claim, so retrying needs no
  hand-editing of the ledger.
- The cost is unchanged and worth stating: the sandbox is disposed with the phase, so a retry
  re-authors the work. Ending the run correctly does not preserve it.
- Every future phase that can fail after acceptance inherits this behaviour instead of
  re-deciding it, and the extracted helper gives the next reader one place to change.
