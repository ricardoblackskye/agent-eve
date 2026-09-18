# #162 — worker progress, completion and questions on the ticket (`WorkerReporter`)

**Branch:** `feat/df-worker-reporter-162` (from `origin/main` = `b00fefe`, which includes #158/#167 via PR #169)
**Issue:** #162 · **Release:** R5 — the first increment after R1–R4 merged
**Feeds:** #163 (the trigger/entry point that constructs the dispatcher) · #164 (definition of done)

## The gap, re-verified

`git grep` for `api.github.com` / `/comments` under `agent/lib/dark-factory/` returns **nothing** — the issue's
claim holds. A worker's progress reaches only `DispatchObserver` → `MetricsStore` (#140), which is a *sensor*,
not a human-facing channel. An autonomous run is therefore silent on the ticket it is working on.

## REVIEW findings — three of them change the plan

### 1. The "emit a structured message" half largely EXISTS

`DispatcherOptions.observer?: DispatchObserver` is already wired, and the `Dispatcher` **awaits**
`this.observer({ type: "dispatch.attempt", runId, attempt, status, worker, delayMs? })` at four state
transitions — every retry, failure and completion already emits a structured, awaited metric carrying exactly
`attempt` and `status`. So progress reporting does **not** need a new sandbox channel: it is a *consumer* of an
existing one. That is worth stating because the issue reads as if a whole emission path must be built.

### 2. `DispatchStatus` has no `blocked` — the WAIT step is the real code change

```text
export type DispatchStatus = "pending" | "dispatched" | "retrying" | "succeeded" | "failed";
```

A parked run is **not** `retrying` — the ACs say a parked run consumes no further iterations and must not burn
worker-minutes — so "the dispatch is marked `blocked`" means **adding a member to the state machine**, with the
resume transition from it. That is the substantive change in this issue, and the piece most likely to be
under-designed. See the decision below.

### 3. A fail-closed repo allow-list exists **and is wired** — reuse it directly

`resolveWorkerAllowedRepos(env)` (`credentials.ts:389`) reads `DF_WORKER_ALLOWED_REPOS`, normalises to lowercase
`owner/repo`, rejects a malformed entry, and is **fail-closed**: an unset/blank list yields `[]`, which makes
*both* `withWorker` (worker-env) and `LocalCredentialBroker.issue` refuse every task. `createCredentialBroker`
passes it into the broker as *"defence in depth, so the allow-list is a property of the credential boundary and
not only of the worker handler."*

**So the reporter calls this function — no new list, no extraction.** One list then governs both what a worker
may touch and where Eve may comment, which is the property that matters: there is no state in which a worker can
work on a repo that the reporter refuses to write to. (An earlier draft of this plan claimed nothing read the
variable; that was wrong, and worse, it would have produced a third allow-list.)

### 4. The comment/label plumbing exists — but *inside* the story provider, so reuse needs one small shared module

`agent/lib/backlog-provider.ts`'s `GitHubProvider` already posts cross-reference comments and adds/removes labels
(`POST /labels`, `DELETE /labels/{label}`), and it carries two lessons worth copying rather than rediscovering:
the gate is *"CLOSED by default"* with a refusal message naming the env var, and finalisation is **lenient about
a repeat** — *"deleting an already-absent label (404) is treated as success rather than a warning, so a retry
never piles up duplicate comments or spurious errors."*

But `BacklogProvider`'s interface exposes only `publish(payload)` — the comment/label calls are private to the
GitHub implementation. Refactoring merged, fail-closed story-publish code is **not** this issue's business, so
the plan adds a small `issue-writer.ts` holding the four primitives (post comment, edit comment, add label,
remove label) plus token resolution, and the reporter uses that. `backlog-provider` can adopt it later; #162 does
not destabilise it now.


### 5. Where the agents actually run (this decides the security story)

`createTesterAgent(env)` returns a **trusted-side** object built in Eve's process; the `ALLOWED_ENV_KEYS`
scrubbing at `tester-agent.ts:58` governs the **child process environment**, and the isolated compute sits behind
`WorkerProvider.exec()` in `worker-env.ts` (whose `ExecResult` carries `output?: string`). So an emission from
the agent module happens outside the sandbox, and the reporter can hold the token in Eve's process exactly as
`LocalCredentialBroker` does. **Nothing needs to cross the sandbox boundary**, which is why the AC "the sandbox
holds no repository credential" stays true by construction rather than by care.

## Design

1. **`WorkerMessage`** — a canonical, provider-agnostic payload validated by `toWorkerMessage()` in the same
   style as `toDispatchEvent`/`toTaskMetric`: `kind: "progress" | "completed" | "question"`, `runId`, `repo`,
   `issue`, plus the per-kind fields (`attempt`/`maxAttempts`; `outcome` + attempts + test evidence; the
   `question` text). Not free prose — the fields are what make it renderable and testable.
2. **`WorkerReporter` seam** — `report(message): Promise<ReportResult>`, **awaited**, mirroring
   `DispatchObserver`'s no-loss discipline so a sink can never lose a message to a floating promise.
3. **Providers**, selected from the environment with a **console/dry-run default**:
   - `ConsoleReporter` (default) — renders to stdout, `mode: "dry-run"`, performs **no** write;
   - `GitHubCommentReporter` — the real write through the four `issue-writer.ts` primitives, gated fail-closed by
     `resolveWorkerAllowedRepos()`; an off-list repo is **refused with an explicit error** and nothing is written;
4. **Idempotence by `(runId, kind)`** — comment ids persist in the `StateStore` under `reporter:${runId}`,
   mirroring `dispatchKey(runId)` = `dispatch:${runId}`. A re-emit **edits** the recorded comment (PATCH) and a
   first emit posts; the store is the source of truth, not a content scan.
5. **One rolling progress comment** — `progress` updates the recorded comment in place, so a 10-iteration task
   cannot spam a ticket. `completed` and `question` get their own comments (both idempotent the same way).
6. **Park and wait** — `question` posts, adds the `needs-answer` label, marks the dispatch `blocked`, and stops
   consuming iterations; a human reply clears the label and the run resumes from `blocked`.

## Decision — RESOLVED at GATE 1: (A) `blocked` is a first-class dispatch state

The WAIT step needs a state to park in, and there are two honest ways to model it:

- **(A) recommended** — add `blocked` to `DispatchStatus`. The dispatch record then tells the truth about the
  run, the resume transition is explicit, and anything reading dispatch state (metrics, the operator, #163's
  trigger) can distinguish "waiting on a human" from "retrying" without a second lookup. Cost: a state machine
  change to a merged, tested module.
- **(B)** leave `DispatchStatus` alone and park the run in a separate `reporter:${runId}` record. Smaller diff,
  but the dispatch record then reports a parked run as `pending`/`retrying`, i.e. it lies — and the cost guard
  would treat a parked run as eligible to retry.

**Resolved (approved): (A) — add `blocked` to `DispatchStatus`.** A run waiting on a human is a first-class
state: the dispatch record tells the truth, the resume transition is explicit, and anything reading dispatch
state (metrics, the operator, #163's trigger) can tell "waiting on a human" from "retrying" without a second
lookup. The cost is a state change to a merged, tested module — which is exactly why it was worth agreeing
explicitly rather than smuggling the state into a shadow record.

## Non-goals (from the issue, kept explicit)

Not metrics capture (#140 already exists — structured progress keeps flowing there); not within-task
self-correction (#137/#138); not interactive chat (a question is answered out of band, then the run resumes).

## Also in scope because the ACs demand it

- `needs-answer` labelling (and clearing it on resume) — the issue's own label vocabulary, distinct from
  `needs-story`/`@eve-agent` (#163 owns the *trigger* side of that, not this).
- Attribution: the comment body must identify **Eve/the orchestrator**, never the sandboxed worker.

## Tasks (RED → GREEN, one behaviour per cycle)

| #  | RED (failing test first)                                                                                                                      | GREEN                                                             |
|----|-----------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| 1  | `toWorkerMessage` refuses an unknown `kind`, a missing `runId`/`repo`/`issue`, and a `question` with empty text                               | canonical payload + validation                                    |
| 2  | a message with an absurd `attempt`, a negative one, or over-long text is REFUSED                                                              | same bounded-field discipline as `toDispatchEvent`/`toTaskMetric` |
| 3  | the console provider renders all three kinds and reports `mode: "dry-run"`                                                                    | default provider, no I/O                                          |
| 4  | with no provider configured, **no HTTP call is attempted at all**                                                                             | fail-closed default (assert the fetch fake was never called)      |
| 5  | a repo **outside the allow-list** is REFUSED with an explicit error and nothing written                                                       | reuse the `DF_WORKER_ALLOWED_REPOS` policy                        |
| 6  | an empty allow-list refuses **everything** (never widens to pass)                                                                             | fail-closed semantics of the existing policy                      |
| 7  | the first emit POSTs and records the comment id against `reporter:${runId}`                                                                   | provider write + store record                                     |
| 8  | the **same** `(runId, kind)` re-emitted EDITS (PATCH) the recorded comment — assert the call count is one POST and one PATCH, never two POSTs | idempotence from the store, not a content scan                    |
| 9  | two `progress` messages maintain **one rolling comment** for a 10-iteration run                                                               | update in place                                                   |
| 10 | different kinds produce different comments, each independently idempotent                                                                     | per-kind ids                                                      |
| 11 | `question` applies `needs-answer` **and** marks the dispatch `blocked`                                                                        | the park step                                                     |
| 12 | a parked run consumes **no** further attempts, and the cost guard sees no worker-minutes                                                      | bounded wait                                                      |
| 13 | a human reply (label cleared) resumes the run from `blocked`                                                                                  | explicit transition                                               |
| 14 | the rendered body names **Eve/the orchestrator**, never the worker                                                                            | attribution AC                                                    |
| 15 | the worker environment contains **no** token while the reporter is live                                                                       | the #142 boundary, asserted                                       |
| 16 | the recorded ids survive a fresh process (read back from the store)                                                                           | durability, as #159/#157 proved it                                |

## Acceptance criteria (from the issue, made concrete)

- one rolling progress comment per run, updated in place — never one per iteration **(9)**
- a `completed` comment naming outcome, attempts used and test evidence **(3, 7)**
- a `question` comment + `needs-answer` + `blocked` + no further iterations **(11, 12)**
- a human reply resumes the run **(13)**
- idempotent by `(runId, kind)`: a retried/delivered message **edits**, never duplicates **(8, 10)**
- no provider ⇒ console/dry-run, no GitHub write **(3, 4)**
- a repo outside the allow-list ⇒ REFUSED, nothing written **(5, 6)**
- the sandbox holds no repository credential and the token never enters the worker env **(15)**
- every comment is attributed to Eve, never the sandboxed worker **(14)**

## Files

`agent/lib/dark-factory/worker-reporter.ts` (new: the payload, the seam, both providers, the env selector) ·
`agent/lib/dark-factory/issue-writer.ts` (new: post/edit comment, add/remove label, token resolution) ·
`agent/lib/dark-factory/dispatch.ts` (`blocked` + the resume transition, if decision A) ·
`agent/lib/dark-factory/index.ts` (exports + wiring) ·
`tests/dark-factory/worker-reporter.test.ts` (new) ·
`tests/dark-factory/dispatch-blocked.test.ts` (new: the parked state and its resume) ·
`scripts/worker-reporter-demo.local.ts` (the demo the issue asks for) · `.env.example` · `README.md` ·
`.cspell.json` if needed.

## Validation

`npx tsc --noEmit` · full `npx vitest run` · `cspell` + `prettier` on changed files · and the **local demo** the
issue explicitly requests: all three kinds rendered through the console provider, a **recording fake provider**
asserting that a retried message edits rather than duplicates, and an off-allow-list repo refused. This is the
same evidence standard as #159/#157/#158: a run, not an assertion.

## Status

**GATE 1 approved — decision A.** `blocked` becomes a first-class `DispatchStatus`, the parked run consumes no
further attempts, and the resume transition is explicit. Implementation is TDD: a RED test per row above, then
the smallest change that turns it GREEN, verified on this laptop before any push.

