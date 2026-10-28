# #521 — the Architect's planning budget fails larger stories

Found while proving #488 (the cost band in the plan comment). Plan branch: `fix/architect-planning-budget-521`,
based on `origin/main` @ `c67ed88`.

## Goal

Three things, in this order of value:

1. A story whose discovery reads the whole evidence budget can **complete a planning attempt**.
2. A timeout **names what it was up against** (prompt size and elapsed time), so the next one is diagnosable from
   the record instead of from the error text.
3. An operator can **raise the budget without a code change**, and small stories behave exactly as they do today.

## Root cause (verified, not inferred)

**A fixed wall-clock budget is a bet against a size-driven cost.** `agent/lib/dark-factory/architect-agent.ts:398`
sets `this.timeoutMs = deps.timeoutMs ?? 60000`, and:

- `scripts/dark-factory-runner.ts:498` constructs `ArchitectAgent` **without** passing `timeoutMs`;
- no environment variable feeds it, so 60 s is not a default an operator can raise — it is the only value;
- the input budget is far larger: `MAX_ARCHITECT_PROMPT_CHARS = 400_000`, with discovery evidence up to
  `MAX_CONTEXT_FILES_READ (24) x MAX_CHARS_PER_FILE (12_000)` = **288,000 chars (~72k tokens)**;
- the configured model is a reasoning model, so generation time scales with input size.

**Evidence from the failure itself.** Run `df572110-df2c-437b-840b-920e6c3f7125` (`webfeedpoc#158`, "Create new
top banner") recorded only two events:

```text
2026-10-28T18:47:52.880Z | trigger | run.accepted    | queued
2026-10-28T18:50:38.164Z | worker  | worker.question | blocked   <- "Planning failed"
```

**165 s ≈ two 60 s attempts plus overhead** — so the retry was equally doomed; it was not a provider blip.

**It is size-dependent, not story-specific.** The same repository, same model, and an equivalent story touching ONE
file (`webfeedpoc#174`, `src/pages/HomePage.jsx`) completed on `[PLAN attempt 1]` with room to spare, and the produced
plan comment was 15,388 chars. The cross-cutting banner story — whose discovery walks far more of the app — could not.

**And the failure was hard to attribute**, because the whole planning phase writes one `worker.question` event: there
is no architect attempt, duration or prompt-size record anywhere, so the cause had to be reconstructed from an error
string. That is the second half of the root cause, not a nice-to-have.

## Intended fix — three legs

1. **An env override that mirrors the existing sibling convention.** `tester-agent.ts:448` already resolves
   `DF_TESTER_TIMEOUT_MS` and **fails closed** on a bad value (`ValidationError` unless it parses as a positive
   integer), defaulting to 60 s. The architect gets the same treatment via `DF_ARCHITECT_TIMEOUT_MS`.
2. **A size-derived default** instead of a fixed 60 s: a floor plus an increment proportional to the prompt size, so
   the budget tracks the thing that actually drives latency. The ABI stays `deps.timeoutMs` for tests.
3. **Diagnostics on the attempt**: `PlanAttemptRecord` (`architect-agent.ts:143`) gains the attempt's `promptChars`
   and `elapsedMs`, and the timeout error names both. The record already carries every attempt's stage and errors
   (#450), so this extends an existing seam rather than inventing one.

## Measurement comes BEFORE the constants — do not invent numbers

The ACs require a story at the full evidence budget to *complete*, so the constants must come from a **measurement**,
not from a guess. Task 3 measures it on the real failing story (`webfeedpoc#158`) with a deliberately generous
override, records the prompt size and the attempt duration from the new diagnostics, and only then are the floor and
the per-char increment chosen — with the numbers and their source written into the plan result, the ADR and the code
comment. A placeholder constant is flagged as such rather than shipped as if derived.

## Tasks (TDD)

| Task | RED                                                                                                                                                                                                                                                                      | GREEN                                                                                          |
|------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| 1    | `tests/dark-factory/architect-timeout-budget.test.ts`: the override wins when set; an invalid override throws `ValidationError` (mirroring `DF_TESTER_TIMEOUT_MS`); a small prompt keeps the 60 s default (AC3 unchanged); a large prompt gets proportionally more (AC1) | `resolveArchitectTimeoutMs(env)` plus size derivation at the call site                         |
| 2    | the attempt record carries `promptChars` and `elapsedMs`, and the timeout error names both                                                                                                                                                                               | `executeGenerate` measures and reports; `PlanAttemptRecord` extended                           |
| 3    | —                                                                                                                                                                                                                                                                        | **measure** on `webfeedpoc#158` with a generous budget; set the constants from the measurement |
| 4    | the guards: `.env.example` documents the new variable (the `env-example-coverage` guard fails otherwise)                                                                                                                                                                 | `.env.example`, the docs page, and the ADR                                                     |

## Files likely to change

- `agent/lib/dark-factory/architect-agent.ts` — override resolution, size derivation, attempt diagnostics.
- `scripts/dark-factory-runner.ts` — resolve and pass the budget.
- `tests/dark-factory/architect-timeout-budget.test.ts` (new), `architect-agent.test.ts` where the ctor default is pinned.
- `.env.example` — the new variable (a guard enforces this).
- `docs/pages/dark-factory-modules.md` / the run-and-operate page — the knob.
- `docs/adr/0072-<slug>.md` + its index row — see the decisions below.
- `.hermes/plans/2026-10-28_architect-planning-budget-521.md` — this file.

## Validation

```bash
npx tsc -p tsconfig.json --noEmit --incremental false
npx vitest run
npx eve build
npx -y cspell@9.1.1 --no-progress -c .cspell.json <changed files>
npx -y markdown-table-formatter@1.6.1 --check <changed markdown>
npx -y markdownlint-cli@0.45.0 -c <config.json> <changed markdown>
```

Plus the real proof for AC1: a `df:local-run` against `webfeedpoc#158` completing a planning attempt, with the
measured prompt size and duration quoted from the new diagnostics.

## Decisions (settled at GATE 1)

- **[Settled] AC2 takes the lighter route: the ATTEMPT record plus the failure text.** `PlanAttemptRecord` and the
  timeout error name `promptChars`/`elapsedMs`. `RunEvent` is NOT extended — that would pull in the event union, its
  validator, `df_run_events` in both stores and the readers for a single diagnostic, while the attempts are already
  the architect's diagnostic seam (#450) and the failure text is what reaches the ticket. Recorded as an explicit
  re-reading of this issue's own AC rather than a silent reinterpretation.
- **[Settled] ADR 0072 is part of this change.** The default budget stops being constant and starts being derived,
  which is a deliberate departure from the obvious approach. 0072 is the next free number (0069–0071 are taken on
  `main`). The ADR takes the Task 3 measurement as its Context, so every number in it has a source.
- **[Settled] the floor stays.** Small stories keep today's 60 s floor exactly, so nothing about them changes; only
  prompts above a threshold buy more time.

## Risks

1. **[Risk] a longer budget holds a stuck run open longer.** A cap keeps the derived value bounded, and the timeout
   remains the safety valve it is today — this changes the budget, not whether one exists.
2. **[Risk] the retry multiplies the wall clock.** Two attempts at the derived budget is the worst case, so both the
   floor and the increment must state that product, not just the per-attempt number.
3. **[Risk] the measurement is one sample on one story.** The measurement proves a maximum-evidence prompt CAN
   complete; it does not bound the slowest possible model response, so the derived budget needs headroom above the
   measured value rather than equality with it — and the operator override is the escape hatch for the rest.
