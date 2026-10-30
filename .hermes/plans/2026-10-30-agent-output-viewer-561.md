# Render captured Agent output on the run detail page (#561)

**Goal:** make the captured agent output *viewable* on the existing run-detail page — type, timestamp,
the bounded summary and the issue-comment link — with an empty state, and with anything the recorder did
not store omitted rather than shown blank.

**Architecture:** a sibling panel in `app/dark-factory/ui/components.tsx`, rendered by the existing page
alongside its other panels. The data is already on the detail view; the page is a client component that
imports panels. No new route, no new write path, no change to what is captured.

**Tech stack:** React + TypeScript, Vitest, the existing `AgentOutputPanel`'s siblings.

---

## Verified reality

| Surface                                                       | Verified state                                                                                                                                                                  |
|---------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `app/dark-factory/runs/[runId]/page.tsx`                      | a client component (`useState`, `export default`) importing sibling panels from `../../ui/components`                                                                           |
| the panels already there                                      | `EventTimeline`, `WorkerCheckpoints`, `MeasuredMetrics`, `OutcomeArtifacts`, `RunDiffPanel`, `TracePanel`, `TestOutputPanel`, `BreakerTripPanel`, plus `StatePanel`/`PanelHead` |
| the run API (`app/api/dark-factory/runs/[runId]/route.ts:49`) | **already returns `events`**                                                                                                                                                    |
| `app/dark-factory/ui/view-model.ts:341`                       | the detail view already carries `events: PersistedRunEvent[]`                                                                                                                   |
| the captured field                                            | `agentOutputSummary`, added to the ledger event by #558 and recorded by the reporter                                                                                            |
| sibling classes                                               | `df-panel`, `df-panel-body`, `df-state-empty` — the convention the siblings use                                                                                                 |

**This issue's body needed no correction**, which is worth stating because the three preceding children
each needed at least one: its claim that the API serves `events` while the page does not render them is
true on both counts.

## Settled decisions

1. **A sibling panel**, not a new surface: `AgentOutputPanel` in `components.tsx`, rendered by the page.
   The convention is documented by its siblings and there is no reason to invent another.
2. **Only captured events are listed.** An event is agent output when it carries a summary — i.e. the
   question/roadblock the recorder stored. Anything else is omitted, which is the issue's "omits any
   event the recorder would not store" criterion, asserted rather than assumed.
3. **Read-only.** No write path, and no change to what is captured: that is the recorder children's job.
4. **An empty state, not an error.** A run with nothing captured renders the existing empty-state
   treatment; a run that *does not exist* keeps the page's existing "Run not found" path, which is a
   different thing and must not be collapsed into the same message.
5. **The comment link opens the posted comment** where a reference exists, and renders nothing when it
   does not — the recorder only stores a reference when it posted one.

## Tasks

### Task 1 (RED): the panel lists captured output

**Files:** `tests/dark-factory/agent-output-panel.test.tsx` (new).

Assert: given a detail view whose events include a captured roadblock, the panel renders its type, its
timestamp and its summary text.

### Task 2 (GREEN): the panel

**Files:** `app/dark-factory/ui/components.tsx`.

### Task 3 (RED): the omissions and the empty state

**Files:** the same test file. Two paired cases, because a panel that renders everything would satisfy
every other assertion:

- an event carrying **no** summary is **not** listed;
- a run with **no** captured events renders the empty state, and does not render an error.

### Task 4 (GREEN): the page renders it

**Files:** `app/dark-factory/runs/[runId]/page.tsx`.

### Task 5: docs

**Files:** the `docs/pages/flow-observability.md` section added by #559 — note that the captured output
is viewable on the run detail page, not only on the ticket.

## Files likely to change

- modify `app/dark-factory/ui/components.tsx`
- modify `app/dark-factory/runs/[runId]/page.tsx`
- create `tests/dark-factory/agent-output-panel.test.tsx`
- modify `docs/pages/flow-observability.md`

## Validation

- Full DSN-enabled suite with the five `*_TEST_DATABASE_URL` vars set and the `_DRIVER` vars unset.
- `tsc --noEmit --incremental false`; `npx eve build`; `next build` — the last is not optional for a
  change that touches a rendered page, because the suite does not catch a build-only break.
- Local lint gate on every changed file: cspell **with the file count asserted**, markdownlint, the
  pinned table formatter, the link check.

## Risks and open questions

1. **The test environment for a React panel.** The siblings' test convention has to be followed rather
   than assumed; reading one existing component test first is cheaper than debugging a rendering harness.
2. **Timestamp formatting.** The event's `occurredAt` is an ISO string; the panel must render something a
   human reads without inventing a locale-dependent format the tests then pin by accident.
3. **Not conflating "nothing captured" with "no run".** Decision 4's separation is what keeps the empty
   state meaningful.
