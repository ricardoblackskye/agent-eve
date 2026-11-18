# #674 — the loop's log must name every declared check and its outcome

**Issue:** [#674](https://github.com/ricardoblackskye/agent-eve/issues/674) (child of #666)
**Branch:** `fix/loop-lint-logs-each-check-674`, based on `origin/main` @ `d53c9e6` (the #682 merge)

## Goal

A reader of the coding loop's log can tell which of the target's declared checks executed, and
which did not — without re-running the loop.

## Root cause (evidence-backed, not inferred)

**The target declares two checks and both are attempted.** `resolveLintCommands` filters a fixed
name list against the target's `package.json` scripts:

```ts
return ["lint", "typecheck"]
  .filter((name) => typeof named[name] === "string")
  .map((name) => `npm run ${name}`);
```

WebFeedPOC declares both — `lint: eslint .` and `typecheck: tsc --noEmit` — so the loop's
`for (const lintCommand of targetLintCommands)` iterates **twice**.

**A check that cannot start is already detected.** `runTests` returns
`{ passed, output, ran }` where `ran: classifyTestRun(output) === "ran"`, and #541's classifier is:

```ts
const DID_NOT_START_MARKERS = [
  "ERR_MODULE_NOT_FOUND",
  "Cannot find package",
  "Failed to load config",
  "failed to load config",
  "command not found",
  "is not recognized as",
];
```

**And then the loop throws that detection away:**

```ts
if (!lint.ran) continue; // UNMEASURED: the check could not start, so it is not a verdict
if (!lint.passed) {
  console.log(`     Lint result: FAIL (${lintCommand})`);
  const lintTail = lint.output.trim().slice(-1200);
  if (lintTail) console.log(`     Lint failure (tail):\n${lintTail}`);
  ...
}
console.log(`     Lint result: PASS (${lintCommand})`);
```

The `continue` prints **nothing**, and discards `lint.output` — which is where the reason lives.

### The evidence, from the logs still on disk

From #230's loop log, iteration 2, in full:

```text
  -> Coding Iteration 2/10...
     Test result: PASS
     Lint result: PASS (npm run typecheck)
```

**One** lint line for two declared checks, and the parenthesised name is the **last** command, so
the only command the log shows is the second one. `npm run lint` was attempted and reported
nothing. Independent of that, the pull request that run produced (WebFeedPOC#231) had a red
MegaLinter on a factory-authored file — #679. A reader of this log could not have known which
check ran, and so could not have asked the question the log should answer.

## Why a silent skip is the worst available behaviour

`if (!lint.ran) continue` is defensible *as a verdict*: an unmeasured check is not a pass, and #659's own comment says so. But the same line is indefensible *as a report*. The distinction
between "this check passed" and "this check never started" is the single most useful thing the
log can carry, and it is the one thing it drops. The comment above the `continue` is accurate and
invisible to anyone reading the run.

## Intended fix

1. **A pure formatter**, beside `classifyTestRun` in `developer-agent.ts`, that turns a command
   and its result into the lines to print — including the case that currently prints nothing.
   The outcomes are the three the run can actually be in: **PASS**, **FAIL** (with its bounded
   tail, as now), and **DID NOT RUN** (naming the command and carrying the bounded reason). When
   the output is empty, say that the check did not report rather than printing an empty tail.
2. **The caller prints it**, so every declared command yields a line and the silent `continue`
   is gone.
3. **An aggregate line** naming the set: how many ran, and how many did not. The issue offers
   per-command lines or the aggregate set; the honest answer is that neither alone is enough —
   the aggregate is what makes a hole in the set unmissable, and the per-command lines are what
   name it.

The term "Lint result" stays: the module already documents "the target's lint" as the set of
checks it declares (#659), and renaming the label is a wider change than this issue asks for.

No ADR. The decision — that an unmeasured check is reported rather than omitted — is exactly what #541 and #659 already intend; this closes the gap between their intent and the log, and the code
comment carries it.

## Tasks (TDD — RED and GREEN as separate commits)

### Task 1 — RED: the formatter reports a check that did not run

`tests/dark-factory/workspace-lint-gate.test.ts` owns this behaviour (#659's allow-list and
resolution cases). Add a describe for #674 asserting:

- a check that **ran and passed** yields a line naming the command;
- a check that **ran and failed** yields a line naming the command, and a bounded tail;
- a check that **did not run** yields a line naming the command **and** the reason from its
  output — the case that currently produces no output at all;
- a check that did not run **with empty output** still yields a line that says so, rather than
  nothing;
- the aggregate names how many of the declared checks ran, so a missing check is visible without
  reading every line.

### Task 2 — RED: a guard the caller cannot silently skip

A source-level guard in the same style as #672's wiring guard: the loop's check block must not
contain a bare `continue` on `!lint.ran` without emitting the formatter's output. This is the
regression guard — the formatter can be perfect and still be bypassed by the same one-liner that
caused this issue.

### Task 3 — GREEN: the formatter and the caller

Add the formatter, print it in both branches, drop the silent skip, add the aggregate.

### Task 4 — confirm against the real log

Re-read `df230-resume.log`'s two differing iterations and state what the new lines would have
read. Do not edit that log; it is evidence.

## Files likely to change

| File                                             | Change                                           |
|--------------------------------------------------|--------------------------------------------------|
| `agent/lib/dark-factory/developer-agent.ts`      | the formatter, beside `classifyTestRun`          |
| `scripts/dark-factory-runner.ts`                 | the caller prints it; the silent `continue` goes |
| `tests/dark-factory/workspace-lint-gate.test.ts` | Tasks 1 and 2                                    |

## Validation

- `npx vitest run tests/dark-factory/workspace-lint-gate.test.ts tests/dark-factory/run-tests-classification.test.ts`
- The **full** suite before the push, with CI's DB env vars and
  `--exclude 'tests/env-example-coverage.test.ts'`. #673's run went green, so the baseline to hold
  is 3665 passed / 0 failed.
- `npx tsc --noEmit --incremental false`
- Local lint gate on changed files: `npx -y cspell@9.1.1`, `npx -y markdownlint-cli` with a config
  **file**, the pinned `npx -y markdown-table-formatter@1.6.1`. This plan file included: fenced
  blocks carry a language, no heading carries trailing punctuation, one trailing newline, every
  `name@version` token in backticks, and no line opens with a bare issue reference.

## Risks and open questions

- **Log volume.** A target declaring many checks multiplies the lines. Bounded per line (the
  existing 1200-character tail) and the count is the target's own declaration, so this is the
  size the target asked for.
- **The reason may be empty** even for a non-run, because the classifier matches markers in
  output. Task 1 covers it explicitly: say the check did not report, never print nothing.
- **A did-not-run check is not a pass** and this change must not make it look like one. That is
  why the aggregate reports the count that did not run, and why the RED asserts the did-not-run
  line does **not** read as a pass.
- **Not in scope:** #679 (the markdown the loop never lints, a descriptor question, not a logging
  one), whether the loop should *install* what a check needs so it can start, and #673's DoD
  result. The issue asks the log to answer the question; making the check succeed is a separate
  argument with its own evidence.
- **This log would have shortened the #226 investigation** from a cross-referencing exercise to
  one line: `DID NOT RUN (npm run lint)` beside the reason its output already carried.
