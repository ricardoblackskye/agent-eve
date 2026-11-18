# #679 — the plan renderer's tables are lint-clean, and nothing pins that

**Issue:** [#679](https://github.com/ricardoblackskye/agent-eve/issues/679) (child of #666)
**Branch:** `fix/plan-table-pipes-align-679`, based on `origin/main` @ `e5c6866` (the #687 merge)

## Goal

The renderer's table alignment is asserted, so a cell narrower than its header cannot return silently.

## What the recon found: the defect is no longer reproducible

The issue was filed from a real artifact — WebFeedPOC#231's `.hermes/plans/df-230.md` — which fails:

```text
.hermes/plans/df-230.md:175:802 error MD060/table-column-style
  Table column style [Table pipe does not align with header for style "aligned"]
```

Reproduced (it still fails, from the artifact as committed), and the cause measured exactly:

```text
line 173 header:    len=800  pipes at [0, 27, 36, 799]
line 174 separator: len=800  pipes at [0, 27, 36, 799]
line 175 row:       len=802  pipes at [0, 27, 36, 801]   <- two chars wider
```

The row's last cell is 2 characters wider than the header's. **But the current renderer does not
produce that.** Rendering a plan through HEAD, using #230's *exact* rationale text extracted from the
artifact, gives three lines that align:

```text
len=802 pipes at 0,27,36,801
len=802 pipes at 0,27,36,801
len=802 pipes at 0,27,36,801
```

and markdownlint with MD060 enabled reports nothing. A second variant — a **bare** URL, the way a model
writes one, so the renderer's `codeSpanUrls` adds backticks — also aligns (`len=673`, pipes identical).
So the escaping/width ordering the renderer documents ("Widths are measured on the ESCAPED, NEUTRALIZED
cell text") **is** honoured on both paths today.

Timeline, which is consistent with that:

| commit    | when             | what                                            |
|-----------|------------------|-------------------------------------------------|
| `14a07c0` | 2026-11-16 14:26 | the padding lands (#659 GREEN)                  |
| `e1959b3` | 2026-11-16 17:46 | #659 merges                                     |
| `475d7ce` | 2026-11-17 17:52 | #666 code-spans inline HTML in the plan's prose |
| `b5d5991` | 2026-11-17 18:12 | #666 drops the comment filter CodeQL flagged    |
| —         | 2026-11-17 20:46 | #231's branch is created (the failing artifact) |

**The most likely explanation is a stale local checkout**, which is a documented hazard for this
workflow: the runner executes from *this* machine's `agent-eve`, that tree is frequently behind
`origin/main`, and a run therefore renders with whatever renderer its HEAD holds. That fits the
evidence (the artifact predates nothing in the timeline, but the checkout used for the run is not
recorded anywhere in the artifact) and it is not something this branch can settle. What it can settle
is that **HEAD is correct**.

## So the deliverable is the pin the issue asked for

The issue said it plainly:

> Worth doing with a test that runs the renderer's output through markdownlint with MD060 enabled -
> the existing snapshot only pins the current bytes, **which is how an unaligned table could be
> snapshotted as correct**.

That is the real gap. The suite pins the rendered bytes, so a renderer that emits an unaligned table
would be snapshotted as correct and stay that way. Nothing asserts the property MD060 actually
enforces.

## Intended fix

**A pure assertion of MD060's `aligned` rule**, in `tests/dark-factory/plan-file.test.ts`, applied to
every table `renderPlanFile` emits (the "Files to change" table and the "Acceptance criteria" table):
for each table, the header, the separator and every row must put their pipes at identical character
offsets. That is what "Table pipe does not align with header" means, and it needs no subprocess -
running `npx markdownlint` inside a unit test would make the guard slow and dependent on the network.

Because that assertion **passes against HEAD**, it is a **GUARD, not a RED**, and it must be labelled as
one. Its proof is the mutation case, which is where the RED is: a deliberately short cell (the column one
character narrower than its header, the shape of the original failure) **must** be caught by the same assertion.
If the assertion is too weak to catch it, the mutation fails - so the mutation is what establishes that
the guard has teeth.

Covered inputs:

- a cell longer than its header (the original failure's shape);
- a cell containing a **bare** URL, which the renderer backticks - the path where a width measured on
  the wrong text would show up;
- a cell containing inline HTML that the renderer neutralizes (#670's path).

## Tasks

### Task 1 — the guard, and the mutation that proves it

Add to `tests/dark-factory/plan-file.test.ts`:

- a helper that parses a rendered table and returns its pipe offsets per line;
- the integration assertion: every table in the rendered plan aligns;
- the mutation case: a hand-built table row whose cell is narrower than its header is reported as misaligned;
- the three input shapes above.

### Task 2 — confirm against the artifact

State, in the PR, that the committed `df-230.md` still fails MD060 (it does - it is evidence and must
not be edited) while HEAD's renderer does not reproduce it, with both command lines.

## Files likely to change

| File                                   | Change                                  |
|----------------------------------------|-----------------------------------------|
| `tests/dark-factory/plan-file.test.ts` | the alignment guard + the mutation case |

No source change: there is nothing to fix on HEAD, and changing the renderer to "fix" a defect it does
not have would be worse than leaving it.

## Validation

- `npx vitest run tests/dark-factory/plan-file.test.ts tests/dark-factory/plan-file-step5.test.ts`
- The **full** suite before the push, with CI's DB env vars and
  `--exclude 'tests/env-example-coverage.test.ts'`. #676's baseline to hold is 3680 passed / 0 failed.
- `npx tsc --noEmit --incremental false`
- The **whole** local gate, every check gated rather than printed: suite exit, `tsc`, cspell's summary
  text, markdownlint with a config **file**, the pinned table formatter, **and the coverage ratchet**.

## Risks and open questions

- **A guard that passes on first run is worth less than a RED, and this says so.** Its value is
  entirely in the mutation case and in failing later: the assertion is the only thing between a future
  renderer change and a red MegaLinter on a factory-authored pull request.
- **The stale-checkout hypothesis is a hypothesis.** It is the best fit for the evidence and it is
  recorded as such, not as a finding. Its consequence is real either way: a run's artifact depends on
  the runner's checkout, and nothing in the artifact records which renderer produced it.
- **Not in scope:** making the factory lint its own artifact inside the loop (that is the descriptor
  question behind #674's evidence), and the target's choice of markdown descriptors.
- **#679 may therefore close as "pinned, not fixed"** - which is the honest outcome when the code is
  already right and only the proof was missing.
