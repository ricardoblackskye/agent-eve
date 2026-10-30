# Capture Developer-agent output (decision-questions + roadblocks) (#559)

**Goal:** wire the Developer's coding loop into the #558 recorder, so an iteration that could not
be **measured** becomes a typed, bounded, posted roadblock instead of being silently reported as
the developer's failure — and so a normal passing run captures nothing at all.

**Architecture:** the loop is where a `WorkerResult` arrives and where its outcome is interpreted,
so the capture belongs there. The recorder bounds and redacts the text and maps it to a `roadblock`
message; the reporter (already wired) records the summary on the run and posts one rolling comment
per run, updating in place. No new capture or posting path is introduced.

**Tech stack:** TypeScript, Vitest, the #558 recorder (`agent-output.ts`), `worker-reporter.ts`.

---

## Verified reality

| Surface                                             | Verified state                                                                                                                                                                                                                                                                    |
|-----------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `runCodingLoop` (`developer-agent.ts:179-197`)      | reads **only `result.passed`** — `passed = (await opts.worker({ iteration: attempt })).passed;` — so `output` and `unmeasured` are **discarded**                                                                                                                                  |
| `WorkerResult` (`:121-126`)                         | `{ passed, output?, unmeasured? }`, where `unmeasured` is documented as *"True when the iteration's tests could not even start (e.g. the checkout is not provisioned), so the result is unmeasured rather than a failure of the developer's work (#541). Absent means measured."* |
| `WorkerFn` (`:128`)                                 | `(ctx: LoopContext) => Promise<WorkerResult>` — the loop's input seam                                                                                                                                                                                                             |
| `runCodingLoop` returns                             | `{ status: "success" \| "failed", iterations, fixCycles }`                                                                                                                                                                                                                        |
| `assertToolAllowed` (`:370`)                        | a pure guard that **throws** `ToolNotAllowedError`; it takes no context and no deps                                                                                                                                                                                               |
| `SkeletonMapError` (`:213,255,297,308,314,334,341`) | thrown from `applySkeletalMap`, likewise with no context seam                                                                                                                                                                                                                     |
| `recordCostRefusal` / `recordBreakerTrip`           | refusals are **already** recorded as typed ledger fields by `governed-agent-call.ts:155` and the runner                                                                                                                                                                           |
| #558 (`agent-output.ts`, merged `a7e7393`)          | `prepare()`, the `roadblock` kind, the ledger summary, and the reporter that posts/updates in place                                                                                                                                                                               |

## The defect this child also closes

`unmeasured` is documented, produced by workers, and **discarded by the loop**, which consults only
`.passed`. So the one case the field exists to distinguish — an unprovisioned checkout — is
reported as a failure of the developer's work, and the loop spends its remaining iterations
retrying an iteration that never ran. Capturing it as a roadblock is what makes the signal
survive. **Changing the run's outcome for an unmeasured result is a separate decision and is not
folded into this change** (see Risks).

## Settled decisions

1. **The capture point is the loop**, where the `WorkerResult` arrives. The roadblock is the
   `unmeasured` result, carrying the iteration's `output` as its bounded, redacted summary.
2. **A normal run captures nothing** — asserted as a paired control, so a capture that fires on
   everything cannot satisfy the suite.
3. **A roadblock must stay recoverable.** `worker.question` requires `blocked`, which is what parks
   a run on a human; a recoverable roadblock forced to `blocked` would stall the factory. The
   loop's existing status semantics are unchanged.
4. **Reuse only:** `prepare()`, the `roadblock` kind and the reporter from #558.

## Scope corrections to this issue's own body — twice

The body named three roadblock types. Two rounds of recon produced two corrections:

- **"A missing allow-listed command"** — real as `ToolNotAllowedError`, **but not reachable from the
  loop**: `assertToolAllowed` is a pure guard with no deps, and a throw from inside the worker
  propagates out of `runCodingLoop` rather than being observed by it. Capturing it needs a seam in
  the sandbox/tool path — a **finding to report**, not a workaround to bolt on. The same applies to
  `SkeletonMapError`.
- **"A cost/breaker refusal"** — already recorded. The increment is only the readable, posted form,
  so this child does not re-record it.
- **"An unmeasurable test"** — I first claimed this **does not exist**; that was wrong. It exists as
  `WorkerResult.unmeasured`, with the `#541` reference. My grep had looked in the wrong file. It is
  the **primary in-scope case**, and the loop currently discards it.

## Tasks

### Task 1 (RED): an unmeasured iteration is a roadblock

**Files:** `tests/dark-factory/developer-agent-output.test.ts` (new).

Assert: a loop whose worker returns `{ passed: false, unmeasured: true, output: "…" }` records
**exactly one** `worker.roadblock`, with a bounded, redacted summary, and the returned status is
**not** `blocked`. Build fixtures inside each test; keep the file collectable.

### Task 2 (GREEN): capture in the loop

**Files:** `agent/lib/dark-factory/developer-agent.ts` (+ an optional recorder on
`CodingLoopOptions`).

Capture without changing the return value the caller already relies on.

### Task 3 (RED): a clean run captures nothing, and a plain failure is not a roadblock

**Files:** the same test file. Two deliberately paired cases:

- a **control**: a passing iteration records **no** captured events;
- a plain *measured* failure (`unmeasured` absent) is **not** captured — the roadblock is for the
  unmeasured case, not for every failed attempt.

### Task 4 (GREEN): the guards for both

**Files:** `developer-agent.ts`.

### Task 5: docs

**Files:** the `docs/pages/` page owning agent-output capture; ADR 0082's consequences if this child
changes what it claims.

## Files likely to change

- modify `agent/lib/dark-factory/developer-agent.ts`
- create `tests/dark-factory/developer-agent-output.test.ts`
- modify the `docs/pages/` page describing agent-output capture

## Validation

- Full DSN-enabled suite with the five `*_TEST_DATABASE_URL` vars set and the `_DRIVER` vars unset.
- `tsc --noEmit --incremental false`; `npx eve build`; `next build`.
- Local lint gate on every changed file: cspell **with the file count asserted**, markdownlint, the
  pinned table formatter, the link check.

## Risks and open questions

1. **The tool/refusal seam is unreachable from the loop.** Reported, not worked around. Offering it
   as its own issue is the right shape.
2. **Should an unmeasured result change the run's outcome?** It currently fails the run and burns the
   remaining iterations retrying. That is a behaviour decision with its own blast radius, out of
   scope here, and worth its own issue if you want it changed.
3. **Not double-reporting.** The runner already reports the loop's progress/completed outcomes; the
   capture must not duplicate those as roadblocks.
