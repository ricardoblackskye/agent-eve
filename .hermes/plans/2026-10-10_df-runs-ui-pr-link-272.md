---
name: df-runs-ui-pr-link-272
description: Plan to surface the pull-request link in the Dark Factory runs detail view (issue #272, Epic #267 P1).
---

# Dark Factory Runs Detail — Surface PR Link (#272)

> **For Hermes:** Use the `ai-sdlc-workflow` + `test-driven-development` skills.
> After this plan is approved, implement task-by-task (RED → GREEN → REFACTOR),
> commit after each task, then open a PR only on explicit authorization.

**Goal:** Make the Dark Factory runs detail view clearly surface the pull-request
link — the one outcome artifact the data model already captures — in a
unit-testable, prominent way, and leave a clean seam for the three deferred
artifacts.

**Architecture:** Pure front-end change on the existing `app/dark-factory` UI.
The PR link already exists on `RunSummary.prUrl` and is rendered today inside
`RunDetailPanel` (`app/dark-factory/ui/components.tsx`, the `df-links` block)
from the raw `summary`. This plan (a) lifts `prUrl` into the `DetailView`
view-model so it is unit-testable and (b) presents it as a clearly-labeled
outcome artifact that becomes the natural home for the deferred diff / test-output
/ reasoning artifacts (#295 / #296 / #297). No schema or backend change.

**Tech Stack:** TypeScript, React (Next.js app router), Vitest + React Testing
Library for the `app/dark-factory-ui` suite, `agent/lib/dark-factory/run-history`
as the read-only type source.

---

## Context and findings

- Epic #267 "Foundations towards UAT" — this is a P1 item. Issue #272's only
  acceptance criterion: *detail view surfaces the diff, test output, PR link,
  and reasoning trace.*
- Read-only review of `agent/lib/dark-factory/run-history.ts`,
  `app/dark-factory/ui/view-model.ts`, and `app/dark-factory/ui/components.tsx`:
  - **PR link** — `RunSummary.prUrl` is captured when a PR opens
    (`agent/lib/dark-factory/definition-of-done.ts` sets it from `pr.url`) and
    is already rendered in `RunDetailPanel` (`components.tsx:364-368`) from the
    raw `summary`. It is **not** part of the `DetailView` view-model, so
    `view-model.test.ts` does not cover it.
  - **Diff / test output / reasoning trace** — never recorded anywhere in the
    run-history model, which deliberately stores no raw prompts or free-form
    content. These are out of scope for this issue.
- **Decision (user-approved):** Do the PR link now; capture the other three as
  follow-up sub-issues.

## Follow-up sub-issues (created, each references #272 + Epic #267)

- **#295 — Agent git diff:** Extend the run-history model + postgres / sqlite
  stores; wire developer-agent / dispatch to record the produced patch
  (redact `DF_*` secrets); render a collapsible diff.
- **#296 — Tester-agent test output:** Record the tester-agent result /
  findings detail (today only aggregate counts exist on `review.round`);
  render pass / fail + output.
- **#297 — Reasoning / trace reference:** Record a reference to the execution
  trace (not raw prompts); render a link.

> The sub-issues were created via the GitHub API and reference #272 in the body.
> Nesting them as GitHub sub-issues can be done in the UI (the `sub_issues` API
> was not available to the token used).

## Proposed approach

1. Add `prUrl?: string` to the `DetailView` interface and populate it in
   `toDetailView` from `summary.prUrl`. This makes the artifact unit-testable
   and is the seam the follow-up issues will extend.
2. Render the PR link as a clearly-labeled outcome artifact. Minimal option:
   keep it in `RunDetailPanel`'s `df-links` and label it explicitly
   ("Pull request — outcome"). Preferred option: a small `OutcomeArtifacts`
   panel with an `OUTCOME` heading that renders the PR link now and will later
   host diff / test-output / reasoning. The panel is added to
   `runs/[runId]/page.tsx`.

## Files likely to change

- Modify: `app/dark-factory/ui/view-model.ts` (add `prUrl` to `DetailView`
  and populate in `toDetailView`)
- Modify: `app/dark-factory/ui/components.tsx` (render the PR link; add
  `OutcomeArtifacts` if the preferred option is chosen)
- Modify: `app/dark-factory/runs/[runId]/page.tsx` (render the new panel /
  artifact)
- Test: `tests/dark-factory-ui/view-model.test.ts`
- Test: `tests/dark-factory-ui/components.test.tsx`
- Test: `tests/dark-factory-ui/run-detail-page.test.tsx`

## TDD plan

### Task 1 — Expose prUrl on DetailView (RED → GREEN)

**Objective:** `toDetailView` returns `prUrl` from the summary so the artifact
is unit-testable.

**Files:** Modify `app/dark-factory/ui/view-model.ts`; Test
`tests/dark-factory-ui/view-model.test.ts`.

#### Task 1 · Step 1 — write failing test

```ts
test("toDetailView exposes the PR link from the summary", () => {
  const view = toDetailView({
    summary: { ...baseSummary, prUrl: "https://github.com/owner/repo/pull/9" },
    events: [],
  });
  expect(view.prUrl).toBe("https://github.com/owner/repo/pull/9");
});
```

#### Task 1 · Step 2 — run test to verify failure

Run: `npx vitest run tests/dark-factory-ui/view-model.test.ts -t "PR link"`

Expected: FAIL — `prUrl` does not exist on `DetailView`.

#### Task 1 · Step 3 — write minimal implementation

In `view-model.ts` add `prUrl?: string;` to the `DetailView` interface and
include `...(summary.prUrl ? { prUrl: summary.prUrl } : {})` in the returned
object.

#### Task 1 · Step 4 — run test to verify pass

Run: `npx vitest run tests/dark-factory-ui/view-model.test.ts -t "PR link"`

Expected: PASS.

#### Task 1 · Step 5 — commit

```bash
git add app/dark-factory/ui/view-model.ts \
  tests/dark-factory-ui/view-model.test.ts
git commit -F .git/COMMIT_MSG
```

### Task 2 — Render the PR link as an outcome artifact (RED → GREEN)

**Objective:** The detail view shows a clearly-labeled PR link.

**Files:** Modify `app/dark-factory/ui/components.tsx`; Test
`tests/dark-factory-ui/components.test.tsx`.

#### Task 2 · Step 1 — write failing test

```tsx
test("OutcomeArtifacts renders the PR link when present", () => {
  const { container } = render(
    <OutcomeArtifacts prUrl="https://github.com/owner/repo/pull/9" />,
  );
  expect(container.textContent).toContain("Pull request");
  expect(
    container.querySelector('a[href="https://github.com/owner/repo/pull/9"]'),
  ).not.toBeNull();
});
```

#### Task 2 · Step 2 — run test to verify failure

Run: `npx vitest run tests/dark-factory-ui/components.test.tsx -t "OutcomeArtifacts"`

Expected: FAIL — component not defined.

#### Task 2 · Step 3 — write minimal implementation

Add to `components.tsx`:

```tsx
export function OutcomeArtifacts({ prUrl }: { prUrl?: string }): ReactNode {
  return (
    <section className="df-panel">
      <PanelHead title="OUTCOME" badges={["ARTIFACTS"]} />
      <div className="df-panel-body">
        {prUrl ? (
          <a
            className="df-outcome-link"
            href={prUrl}
            target="_blank"
            rel="noreferrer"
          >
            Pull request — agent outcome ↗
          </a>
        ) : (
          <StatePanel state="empty" message="No PR opened yet" />
        )}
      </div>
    </section>
  );
}
```

#### Task 2 · Step 4 — run test to verify pass

Run: `npx vitest run tests/dark-factory-ui/components.test.tsx -t "OutcomeArtifacts"`

Expected: PASS.

#### Task 2 · Step 5 — commit

### Task 3 — Wire the panel into the detail page (RED → GREEN)

**Objective:** The runs detail page renders the outcome artifact.

**Files:** Modify `app/dark-factory/runs/[runId]/page.tsx` + its import; Test
`tests/dark-factory-ui/run-detail-page.test.tsx`.

#### Task 3 · Step 1 — write failing test

Extend the run-detail-page harness fixture so the run carries `prUrl`, then
assert the PR link is present in the rendered output.

#### Task 3 · Step 2 — run test to verify failure

Run: `npx vitest run tests/dark-factory-ui/run-detail-page.test.tsx`

Expected: FAIL (artifact absent).

#### Task 3 · Step 3 — wire it

In `page.tsx` import `OutcomeArtifacts` and render
`<OutcomeArtifacts prUrl={view.prUrl} />` inside `df-detail-grid`.

#### Task 3 · Step 4 — run test to verify pass

Run: `npx vitest run tests/dark-factory-ui/run-detail-page.test.tsx`

Expected: PASS.

#### Task 3 · Step 5 — commit

### Task 4 — Local lint gate + full suite

- Run the repo linters locally on the changed files:
  `npx cspell@8 --config .cspell.json "app/dark-factory/ui/view-model.ts"`
  `"app/dark-factory/ui/components.tsx"`
  `"app/dark-factory/runs/[runId]/page.tsx"`
  and `npx tsc --noEmit --incremental false` (the `--incremental false` flag
  avoids a stale tsbuildinfo false-green).
- Run the full UI suite: `npx vitest run tests/dark-factory-ui`.
- Resolve every lint / type / test finding before pushing.

## Validation

- `npx vitest run tests/dark-factory-ui` — all UI tests pass.
- `npx tsc --noEmit --incremental false` — clean.
- Manual: a completed run that opened a PR shows the `OUTCOME` panel with a
  working "Pull request — agent outcome ↗" link; a run with no PR shows the
  empty state.

## Risks and open questions

- **Scope:** the PR link already renders today inside `RunDetailPanel`
  (`df-links`). This plan promotes it to a dedicated, labeled artifact and
  lifts it into the view-model for testability. If the reviewer prefers the
  link stay in `RunDetailPanel`, Tasks 2 and 3 collapse into a small label
  tweak there.
- **No live pipeline needed:** the existing UI test harness
  (`tests/dark-factory-ui/harness.test.tsx`) supplies fixtures, so the UI can
  be verified without a real dev / tester agent opening a PR.
- **Deferred artifacts** (diff / test output / reasoning) are tracked as
  #295 / #296 / #297 and are intentionally not built here.

## Commit and branch

- Branch: `feat/df-runs-ui-pr-link-272` (off `origin/main`; no `#` in the name).
- This commit contains the plan only; implementation commits follow after approval.
