# Capture Tester-agent output (unmeasurable-test + refusal roadblocks) (#560)

**Goal:** capture the roadblock the Tester genuinely owns — a **command its own guard refuses** — as a
typed, bounded, posted roadblock, and prove that a normal validation result captures nothing.

**Architecture:** the refusal is thrown by a pure guard inside the Tester, so it cannot observe its own
caller; the capture belongs where the Tester drives the runner. The recorder bounds and redacts, the
reporter records and posts one rolling comment per run. No new store, comment or event path.

**Tech stack:** TypeScript, Vitest, the #558 recorder (`agent-output.ts`), `worker-reporter.ts`.

---

## Verified reality

| Surface                        | Verified state                                                                                                                                                                                       |
|--------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `tester-agent.ts`              | a **validation** agent: `TesterAgent`, `createValidationReport`, `ValidationReport`, `TestResult`, `SecurityResult`, `CheckResult`, `ValidationError`, `ValidationFailedError`, `parseErrorOutput`   |
| `ALLOWED_COMMANDS` (`:57`)     | `{ tsc, cspell, vitest, gitleaks }`                                                                                                                                                                  |
| `defaultCommandRunner` (`:91`) | refuses anything else: *"Command not allowed: … Only npx with whitelisted commands (tsc, cspell, vitest, gitleaks) are permitted."*                                                                  |
| reporter usage                 | **none** — the Tester neither imports nor calls one                                                                                                                                                  |
| callers                        | `architect-agent.ts`, `child-env.ts`, `index.ts`, `worker-reporter.ts` (re-export)                                                                                                                   |
| the unmeasured signal          | produced by the **sandbox driver** ("A command that could not begin is unmeasured, not a failure of the developer's work (#541)") and surfaced as `TestOutcome.ran === false` to the runner's worker |

## Scope corrections to this issue's own body

The body named two roadblock types. Recon shows one is already delivered and one is already recorded:

- **"An unmeasurable test"** — **already captured.** That signal is `TestOutcome.ran === false` from the
  sandbox driver, on the path the runner's worker walks, and #559 (merged `02a06a8`) already records it as
  a roadblock. This child must not build a second capture for it; the acceptance criterion is instead
  **evidence that it holds**, not new work.
- **"A cost or breaker refusal"** — already recorded as typed ledger fields (`recordCostRefusal`,
  `recordBreakerTrip`). #559's runner wiring already posts roadblocks from that path, so again the
  increment is evidence, not a second recorder.
- **The Tester's own roadblock is a refused command.** `defaultCommandRunner` refuses anything outside
  `{tsc, cspell, vitest, gitleaks}` — and #559's plan recorded exactly this as unreachable from the loop:
  *"`ToolNotAllowedError` and `SkeletonMapError` … are pure guards that throw, with no context or deps, so
  the throw propagates rather than being observed."* Here it **is** the Tester's own guard, so this child
  is where capturing it belongs.

## Settled decisions

1. **Capture the refused command**, naming the command, bounded and redacted.
2. **A normal validation result captures nothing** — a passing run *and* a plain failing validation both
   produce zero captured events, asserted as paired controls, so a capture that fires on every result
   cannot satisfy the suite.
3. **The unmeasured case is asserted, not rebuilt.** A test proves the path #559 wired still records a
   roadblock, so a later refactor that drops it fails here rather than silently losing coverage.
4. **Reuse only**, with the same identity discipline as #559: identity from the run, an `eventId` stable
   per run+occurrence so a retry EDITS the rolling comment, and the capture wrapped so an observability
   failure cannot change the Tester's own verdict.

## Tasks

### Task 1 (RED): a refused command is a roadblock

**Files:** `tests/dark-factory/tester-agent-output.test.ts` (new).

Assert: driving the Tester with a command outside the allow-list records **exactly one**
`worker.roadblock` naming the command, bounded and redacted, and the Tester still reports its refusal to
its caller unchanged (the capture is an addition).

### Task 2 (GREEN): wire the refusal

**Files:** `agent/lib/dark-factory/tester-agent.ts` (+ an optional tap on whatever drives the runner, if
a seam has to be added — a pure guard cannot observe its own caller).

### Task 3 (RED): the controls

**Files:** the same test file, two paired cases:

- a **control**: a passing validation records **no** captured events;
- a second control: a *plain failing* validation (the code is wrong) is **not** a roadblock — that is a
  normal result, and the DoD already handles it.

### Task 4 (RED): the unmeasured path still records

**Files:** the same test file. Assert that the path #559 wired — an unmeasured test result — still
records a roadblock, so this child pins the coverage it did not build.

### Task 5: docs

**Files:** the `docs/pages/flow-observability.md` section added by #559 — extend it with the Tester's
refusal case.

## Files likely to change

- modify `agent/lib/dark-factory/tester-agent.ts`
- create `tests/dark-factory/tester-agent-output.test.ts`
- modify `docs/pages/flow-observability.md`

## Validation

- Full DSN-enabled suite with the five `*_TEST_DATABASE_URL` vars set and the `_DRIVER` vars unset.
- `tsc --noEmit --incremental false`; `npx eve build`; `next build`.
- Local lint gate on every changed file: cspell **with the file count asserted**, markdownlint, the
  pinned table formatter, the link check.

## Risks and open questions

1. **A pure guard cannot observe its own caller.** `defaultCommandRunner` has no context, so the capture
   either joins a seam on whatever drives it or it cannot be captured at all. If the latter, that is a
   finding to report rather than a workaround.
2. **Not double-recording.** The refusal is a *result* the Tester already returns to its caller; the
   capture must not change that verdict or duplicate the existing validation reporting.
3. **Cost/breaker refusals are already recorded** — asserting rather than re-recording keeps this child
   from adding a second writer for the same fact.
