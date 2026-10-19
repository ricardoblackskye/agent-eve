# #381 R2 — make the right target REQUIRED

**Issue:** #381 (AC3, AC4) · **Branch:** `feat/df-architect-target-rules-381` · **Base:** `54be2bf` (R1 merged)

**Release split.** R1 (`feat/df-architect-reads-381`, merged `54be2bf`) gave the Architect eyes: bounded reads,
deterministic discovery, evidence in the prompt. R1 makes a better target **likely**. R2 makes the right target
**required**, by refusing a shell or a shared component as the target of a page-scoped story, and by parking
instead of guessing when the surface cannot be decided.

## What already exists, and the gap that remains

R1 computes, per plan attempt, a `DiscoveryResult`: every reachable file with a **role** (`route`, `shell`,
`page`, `shared`, `component`), the **composition chain**, and the **surface** the story names (`{ route, page }`).
All of it already reaches the prompt as escaped evidence.

The gap: **nothing acts on it.** A plan can cite the evidence, ignore it, and still be accepted — which is how
`src/App.jsx` (the shell) became a target in WebFeedPOC #168 round 2 with a confident rationale. AC3 closes that.

## The distinction the rule depends on

Two story scopes, and telling them apart is the whole design. A naive rule — "never target a shell" — would
block legitimate work, because some stories are *about* the shell.

| scope             | signal                                                                                                                                       | shell / shared target                         |
|-------------------|----------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------|
| **page-scoped**   | the story names one surface: the resolved surface exists, or the text carries a UI signal ("main page", "the settings screen", a route path) | **refused** — this is AC3                     |
| **shell-scoped**  | the story is about something rendered everywhere: "every page", "all pages", "the nav", "the header", "the footer", "the layout"             | **allowed** — the shell is the correct target |
| neither (backend) | no UI signal                                                                                                                                 | allowed (shared modules legitimately change)  |

The shell-scoped signal **wins** over the page-scoped one, so "the heading on every page" stays shell work.
That precedence is the false-positive guard, and it is tested explicitly.

## The refusal (AC3)

`validateExecutionPlan(plan, storyText, context?)` — currently pure over `(plan, storyText)` — gains an
**optional** third argument:

```ts
context?: { roles?: Record<string, FileRole>; surface?: { route?: string; page?: string } }
```

For a page-scoped story, a target whose role is `shell` or `shared` becomes a validation error that names the
file, its role, the evidence that proves the role, and the resolved page. Naming all four is what lets the
existing repair loop fix it rather than re-guess.

**Existing callers pass no context and behave exactly as today** — the property the current validator tests pin.

## The park (AC4)

When a story is page-scoped and the surface **cannot be resolved** — discovery found no chain, or no roles were
available — the Architect must not guess a target. It reports that as a distinguishable outcome, and the runner
**parks the run for a human** rather than failing it:

- post WHY on the ticket (the #365 R4 precedent: a blocked ticket carrying only a label leaves a human guessing),
- add the `question` label,
- park through the existing `parkForApproval`, which marks the run `blocked` so `entry.ts` can resume it.

`parkForApproval` currently reports one fixed `PLAN_APPROVAL_QUESTION`, so this task adds an **optional question
override** — additive, defaulting to today's text, so the approval path is untouched.

The same park fires when a plan still targets a shell or a shared component after the repair rounds are spent
(`maxPlanRetries: 2`): refusing to proceed is the fail-closed outcome, and a human decides.

**Why a park and not a terminal failure:** AC4 says *parks the run for a human*. A failed run ends the work; a
parked run is resumable, and the answer may simply be "the shell is right, go ahead".

## Tasks

Each is a RED/GREEN pair as separate commits, per the standing workflow.

| # | task                                                                                                                                                                 | AC       |
|---|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| 1 | Scope classification: `isPageScopedStory` / `isShellScopedStory`, pure, driven by fixture stories including the precedence case                                      | AC3      |
| 2 | The exclusion rule in `validateExecutionPlan` with the optional context; shell and shared both refused for a page-scoped story, naming file + role + evidence + page | AC3      |
| 3 | The Architect surfaces `roles` and `surface` on `ArchitectResult`, and reports an unresolvable surface as a distinguishable outcome instead of a plan                | AC3, AC4 |
| 4 | `parkForApproval` gains the optional question override                                                                                                               | AC4      |
| 5 | The runner parks (blocked + reason on the ticket + question label) instead of `applyTerminalLifecycle(failed)` for both AC4 causes                                   | AC4      |
| 6 | ADR 0048, module docs, ADR index                                                                                                                                     | —        |

## Validation

- **The case that failed:** a story saying "the main page", with the WebFeedPOC shape from R1's fixture. Targeting
  `src/App.jsx` (shell) or `src/components/ProductList.jsx` (shared) is REFUSED, and the error names
  `src/pages/HomePage.jsx` as the resolved page.
- **The false-positive guard:** "the heading on every page" targeting the shell is ACCEPTED.
- **The fail-closed case:** a page-scoped story where discovery resolves no surface parks, the ticket says why,
  and the run is resumable rather than terminal.
- **Backward compatibility:** callers without the context see identical behaviour; the existing validator and
  architect suites pass unchanged.
- A backend story may still change a shared module.
- `tsc --noEmit`, full suite, root guards, doc-drift guards, and the local lint gate on every changed file.

## Risks

1. **False positives block legitimate work.** A shell change is legitimate; the precedence rule above is the
   mitigation, tested as a task rather than reasoned about.
2. **A repo whose routes are implied by file paths resolves no surface, so every page-scoped story parks.** Measured
   in R1 on this repository: 718 files, no chain. Parking is fail-closed and correct in principle, but noisy in
   practice. Extending discovery to path-implied routes is a **follow-up issue**, deliberately not solved here.
3. **Each refusal costs a repair round** (`maxPlanRetries: 2`). Bounded, and tolerable precisely because the
   refusal names the page, so the retry has something to act on.
4. **Coverage** of new branches; the ratchet is measured with the Postgres variables set, as CI does.

## Out of scope

- Extending discovery to path-implied routes (follow-up issue).
- Approval semantics: #378 / ADR 0041 opt-in approval is unchanged, and R2 adds no new way to approve.
- Any change to the cost path; R2 adds no model call.

## Task 7 (ADDED after the first live end-to-end) — discovery must resolve the route shape real apps use

The first live run against WebFeedPOC #169 parked instead of planning. The park was CORRECT for the evidence
available, but the evidence was incomplete, and the reason is only visible by reading the target:

```jsx
<Route path="/" element={<App />}>        // "/" renders the SHELL: App renders an <Outlet>
  <Route index element={<HomePage />} />  // the page "the main page" means is an INDEX CHILD
```

Two gaps, both found by running rather than by reading:

1. **A route's page can be an index child.** Resolving `path="/"` yields the shell, and the page the story names
   is the child that carries no `path`. Discovery must follow that, or the surface resolves to the shell - the
   exact mistake R2 exists to prevent.
2. **A test file can be selected as the route table.** `src/App.test.jsx` declares `<Routes>` and sorts before
   `main.jsx`, so it wins the "first file that declares routes" rule. A test is not the route table.

Task 7 fixes both, against a fixture shaped like WebFeedPOC's own `main.jsx` and `App.jsx` rather than a
simplified stand-in. **Acceptance is the end-to-end**: a page-scoped story on WebFeedPOC resolves the surface to
`src/pages/HomePage.jsx`, the plan targets it rather than the shell, and an acceptable plan is posted on the
issue. Unit tests alone do not close this task.

## Task 8 (ADDED after the second live end-to-end) — the prompt must be a contract, not a bias

The second live run resolved the surface correctly (`{ route: "/", page: "src/pages/HomePage.jsx" }`) and then
failed on the PLAN, not on discovery:

```text
ArchitectAgent max retries exceeded (2). Errors:
  Target file 'src/components/Header.js' action must be 'create', 'modify', or 'replace' (received 'undefined').
```

Five target files the repository does not contain (`Header.js`, `Footer.js`, `App.js`, `App.test.js`,
`index.js`), aimed at the shell and the shared components - and a separate `ExecutionPlan` key the schema never
asked for. The cause is a line in the prompt itself:

```text
- If the story touches UI/Chat (mentions "chat ui", "user navigates", "page", "browser", "screen"),
  targetFiles MUST include UI entrypoints under app/ or components/ (e.g. app/page.tsx, app/chat.tsx).
```

The story says "on the main page", which matches "page", so the prompt ORDERS the model at `components/` - the
shared and shell files R2 exists to refuse - and offers Next.js paths as its example. Discovery had already
proved which file the page is; the prompt sent the model elsewhere, and the schema error then exhausted the
retries and aborted the run instead of parking.

Three fixes, following obra/superpowers' discipline that a plan is "the set of decisions the implementer cannot
make alone", and that anything enforceable should be validated rather than documented:

1. **A closed file contract in the prompt.** Every `targetFiles` path MUST appear in `Existing files`. For a
   page-scoped story the resolved page is the mandated target, and a `shell` or `shared` file is named as
   forbidden. The blind `app/` + `components/` heuristic is demoted to a fallback, used only when discovery
   resolved no page at all.
2. **Existence is validated, not requested.** `PlanValidationContext` gains `files?: string[]`; a target path
   absent from it raises a `target-missing` error naming the path. This is mechanical, so it belongs in the
   validator - it would have killed all five invented paths on the first attempt.
3. **A prompt that cannot produce a valid plan is a QUESTION, not a crash.** Validation exhaustion currently
   aborts the run. A plan-quality failure is answerable by a human, so the Architect reports a `plan-invalid`
   reason and the runner parks with the validation error as the question - the same fail-closed but resumable
   posture as AC4. Aborting stays reserved for faults a human cannot answer.

**Acceptance is still the end-to-end**: WebFeedPOC #169 resolves `src/pages/HomePage.jsx`, the plan targets it
rather than the shell, and an acceptable plan is posted on the issue.
