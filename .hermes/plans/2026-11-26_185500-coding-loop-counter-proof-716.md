# Prove the iteration count tracks the attempts actually made (#716)

**Issue:** [agent-eve#716](https://github.com/ricardoblackskye/agent-eve/issues/716) — the fix landed in #769; this plan
covers the proof, which is the only part of the acceptance still open.
**Branch:** `test/716-counter-derivation` — changed one file, added `tests/dark-factory/coding-loop-count-716.test.ts`.
**Status:** implemented and verified.

> **Written retrospectively.** The change went straight to the test without a plan file. This records it afterwards at
> the reviewer's request, and it states the reasoning that actually drove the decisions rather than a tidied-up
> version of it. Everything below was measured before the code was written; only the write-up is late.

## The acceptance as written cannot be satisfied by observation

Issue #716 asks for *"a run's ledger row shows a count that matches its own log (`Coding Iteration 2/10` -> 2)"*. Two
independent facts make that unreachable on the runs available:

1. **Every post-fix run recorded `1`.** A one-iteration run cannot distinguish a working counter from a hardcoded one
   (#271 and #273 both recorded `1`, and the pre-fix code could only write `0`). So a green here would not have been
   evidence, and hunting for a two-iteration run would have been hunting a coincidence.
2. **The local launcher pipes its output through `tail`, so the `Coding Iteration N/10` lines were discarded.** The
   evidence was not missing from the run - the capture threw it away. "We could not observe it" and "it was not
   observable" are different problems, and only the second one is a reason to give up on the observation.

## What is actually unproven, and where the chain is

The fix in #769 supplies real counts. The link left unproven is the FIRST one:

| Step                                         | Where                                                                               |
|:---------------------------------------------|:------------------------------------------------------------------------------------|
| the loop counts its own attempts             | `developer-agent.ts:374` — `iterations = attempt`                                   |
| retries are separated from the first attempt | `developer-agent.ts:400` — `const fixCycles = passed ? iterations - 1 : iterations` |
| the runner passes them on                    | `dark-factory-runner.ts:1711` — `iterationCount: loopResult.iterations`             |

## Decision

Prove `attempts -> iterations` deterministically, driving `runCodingLoop` for real attempts. That is the observable
equivalent of the `Coding Iteration N/10` lines, without depending on a run's luck in reaching a second iteration.

## The cases, and why all three

| driver                                     | expected                       |
|:-------------------------------------------|:-------------------------------|
| fails twice, passes on the third           | `iterations 3` · `fixCycles 2` |
| same `maxIterations: 5`, passes first time | `iterations 1` · `fixCycles 0` |
| never passes, `maxIterations: 2`           | `iterations 2` · `fixCycles 2` |

**Sensitivity is the set, not one case.** The first two share the same `maxIterations`, so a counter echoing the option
fails the control; the third pins the other branch of `passed ? iterations - 1 : iterations`, without which an
unconditional `- 1` passes both of the others.

## Verification

`3 passed` · `tsc --noEmit` exit 0 · cspell exit 0 over the changed file · full gate **436 files / 3939 passed /
0 failed** · coverage ratchet exit 0 (statements -0.01pp, branches -0.02pp, inside tolerance, so the floor is
unchanged rather than lowered).

## What this does not prove

The forwarding at `dark-factory-runner.ts:1711` is verified by reading, and the DoD-boundary supply is covered by
Issue #769's own tests. What remains unobserved is the live COMBINATION - a real run whose log is captured in full and whose
row can be compared against it. That is now a corroboration rather than the proof, and it is worth doing only if the
launcher's output is redirected to a file instead of piped to `tail`.

## Correction carried forward

`fix_cycle_count = 0` on the #273 run was flagged as a discrepancy against three "Fix cycle prepared" lines. The
formula above explains it: the developer loop passed on its first attempt, so `0` is correct, and those preparations
belong to the DoD's review-driven cycle, counted separately as `review_count = 3`. The counters are coherent.
