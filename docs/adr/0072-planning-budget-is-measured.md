# 0072 — The Architect's planning budget is measured, and raisable

Date: 2026-10-28
Status: Accepted

## Context

A story failed to plan at all. Two consecutive attempts hit a hard-coded wall-clock budget
(`architect-agent.ts`: `deps.timeoutMs ?? 60000`), 165 s apart, and nothing recorded why: the runner never passed
the budget, no environment variable fed it, and the entire planning phase wrote a single `worker.question` event.
The cause had to be reconstructed from an error string in a ticket comment.

The obvious hypothesis was that the prompt had outgrown the budget, because the Architect may send up to 400,000
chars with evidence of up to `24 x 12,000 = 288,000` chars. **Measurement refuted it:**

| what was measured                                                           | result                                                                                                    |
|-----------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| input latency — four probes of the configured model, 12,000 → 288,000 chars | 1,055 ms → 1,391 ms, i.e. **~12 ms per 10,000 chars**. A 24x bigger input costs ~0.34 s                   |
| output generation — 2,000 and 4,000 token completions                       | 8.3 s and 14.3 s, i.e. 242–279 tokens/s, so the Architect's maximum 8,000-token output costs **~29–33 s** |
| the SAME story re-run on the SAME 60 s budget                               | succeeded on attempt 1                                                                                    |

The worst case is therefore ~35 s against a 60 s floor, so the observed failure was an **outlier window** — and a
provider stall is precisely the cause that dooms both retries, which is what made the first diagnosis wrong.

## Decision

Keep the 60 s floor, now justified by measurement rather than inheritance: it is roughly **1.7x** the measured
worst case (maximum output plus maximum evidence). Add an increment derived from the measured input rate
(`ARCHITECT_TIMEOUT_MS_PER_10K_CHARS = 12`). Make the budget raisable with `DF_ARCHITECT_TIMEOUT_MS`, which fails
closed on any value that is not a positive integer. Record every attempt's prompt size and duration on the attempt
record and in the failure text.

## Consequences

- An operator can ride out an outlier window by raising the budget. Before this there was **no lever at all**, which
  is the real defect the incident exposed.
- A timeout is now attributable from the record. The verifying run reported `prompt 130236 chars, took 1018ms` where
  previously there was only an error string, and that line is what produced the measurements above.
- The increment is deliberately **small**, because input is measured to be nearly free. The floor does the work; the
  term exists so the budget stays honest if a future model prices input differently. It is not a guess, and it must
  not be inflated without a new measurement.
- Unchanged: the timeout still exists, and the retry count is still 2, so the worst case is two attempts at the
  budget.
- The size hypothesis is recorded here **as refuted**, so the same plausible-but-wrong reasoning is not re-derived
  from the incident alone.
