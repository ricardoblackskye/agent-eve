# The env-coverage walker stops scanning Dark Factory sandbox checkouts

**Goal:** `tests/env-example-coverage.test.ts` stops demanding another project's environment variables
when a Dark Factory sandbox checkout is sitting in the working tree.

**Architecture:** `SKIP_DIRS` gains `df-workspaces` — the factory's scratch checkouts of OTHER
repositories, gitignored and untracked — and the check is parameterised by root so the skip is asserted
**behaviorally** on a temporary tree instead of by grepping the constant.

**Tech stack:** TypeScript, Vitest, `node:fs`.

**Issue:** [#563](https://github.com/ricardoblackskye/agent-eve/issues/563) (bug)

**Branch:** `fix/env-coverage-skips-df-workspaces-563`

## Root cause (verified, not inferred)

- `tests/env-example-coverage.test.ts:35-42` — `SKIP_DIRS` is `node_modules`, `.git`, `tests`, `evals`,
  `dist`, `.next`.
- `walk()` (line 46) recurses into every directory. Its only other guard is the dot-prefix skip on line
  49, and `df-workspaces` is not hidden, so it is traversed.
- `df-workspaces/` is gitignored (`.gitignore:19`) and holds **14** untracked sandbox checkouts
  (`webfeedpoc-177`, `webfeedpoc-179`, `webfeedpoc-202`, …) of the WebFeedPOC project.
- Those checkouts reference the Wix/Eve/webhook variables, including all 12 the test demands.
- **Reproduced on unmodified `main`:** `Tests 1 failed | 1 passed`, with exactly the 12 names the issue
  lists.

## Why it matters

Any developer with a sandbox run in their tree gets a spurious suite failure that names another
project's settings, and it reads like a regression in whatever they are working on. CI never sees it
(there is no such directory there), so a local tally cannot be compared with CI - which is precisely how
this surfaced during the #691 gate.

## Intended fix

1. `SKIP_DIRS` gains `"df-workspaces"`, with a comment saying what it is and why it does not belong to
   this repository's config surface.
2. The check is parameterised by root, so a test can drive it over a tree it owns:
   `walk(dir)` already takes a directory; `extractSourceEnvVars()` and `extractDocumentedVars()` take a
   `root` defaulting to `ROOT`.
3. The acceptance criteria become two behavioural tests over a `mkdtempSync` tree (see Task 1). A fixture
   inside a **temporary** root is chosen over writing into the repo's own `df-workspaces/`: the same
   `df-workspaces/` shape is exercised, but the test stays deterministic and does not depend on - or
   disturb - whatever sandbox checkouts happen to be on the machine.

## The decision this makes, and the alternative

Skipping an explicit directory name keeps the walker consistent with the six entries already in
`SKIP_DIRS` and easy to read. The alternative - deriving the skip from `.gitignore` - would skip
whatever anyone gitignores, needs a parser for the pattern syntax, and makes the walker's behaviour
depend on a file it does not own. The comment in the code answers "why is this skipped?", so **no ADR**
is proposed; say so if you would rather have one.

## Tasks

### Task 1 - RED: the skip is asserted behaviorally

**Objective:** two tests that fail today for the right reason: the sandbox variable leaks into the
required set, while a real source variable is still reported.

**Files:** `tests/env-example-coverage.test.ts`

Fixture, per test, under `mkdtempSync(join(tmpdir(), "env-coverage-"))`:

```text
<tmp>/df-workspaces/webfeedpoc-177/src/sandbox.ts   process.env.VITE_WIX_SITE_URL
<tmp>/src/real.ts                                    process.env.UNDOCUMENTED_SETTING
<tmp>/.env.example                                   (empty)
```

```ts
it("does not scan a df-workspaces sandbox checkout of another project", () => {
  const vars = extractSourceEnvVars(root);
  expect(vars.has("VITE_WIX_SITE_URL")).toBe(false);
});

it("CONTROL: still reports a real source variable that .env.example omits", () => {
  // Without this, a skip list widened to everything would pass the test above.
  const vars = extractSourceEnvVars(root);
  expect(vars.has("UNDOCUMENTED_SETTING")).toBe(true);
});
```

**Run:** `npx vitest run tests/env-example-coverage.test.ts`
**Expected RED:** the first test fails - `expected true to be false`, because the sandbox file is
walked. The control must PASS in RED, or the fixture is wrong.

### Task 2 - GREEN: the one-line skip

**Files:** `tests/env-example-coverage.test.ts`

Add `df-workspaces` to `SKIP_DIRS` with its comment. **Run** the file: **4 passed** (2 existing + 2 new).
The existing `ROOT`-based test passing is the real-world proof, since it fails on `main` on this machine.

### Task 3 - the gates

`npx tsc --noEmit --incremental false`; the full suite (expect the same tally as `main`, with this file's
failure gone); the pinned `markdown-table-formatter@1.6.1` and `cspell@9.1.1` over the changed files;
`npm run coverage:ratchet`.

## Files likely to change

| file                                 | change                                                             |
|--------------------------------------|--------------------------------------------------------------------|
| `tests/env-example-coverage.test.ts` | `SKIP_DIRS` entry; root parameterisation; two tests; a header note |

No product code, no `.env.example` content (**acceptance criterion 4**), and none of the 12 variables -
they are another project's settings.

## Validation

- `npx vitest run tests/env-example-coverage.test.ts` -> 4 passed, on a machine **with** the sandbox
  checkouts present (`df-workspaces/` untouched).
- Full suite: no new failures; the file's previous failure is gone.
- The two new tests proven RED first, and the control proven to pass in RED.

## Risks and open questions

1. **Only `df-workspaces`, or any gitignored directory?** Scoped to the named directory, per the
   acceptance criteria; a gitignore-derived skip is the alternative above.
2. **Other walkers may have the same gap.** If a second test harness scans the working tree, it will trip
   on a sandbox checkout the same way. Worth one `grep` for other `readdirSync` recursions; anything
   found becomes its own issue rather than widening this change.
3. The skip matches the directory name at **any** depth, so a nested `df-workspaces` is covered too.
