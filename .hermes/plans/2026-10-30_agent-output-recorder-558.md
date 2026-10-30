# Agent-output recorder + taxonomy, wired to the Architect (#558)

**Goal:** introduce one extendable recorder that captures each Agent's notable output as typed, capped, redacted events stored against the run, and optionally posted as a single readable comment on the issue — with the Architect wired first as the smallest end-to-end path.

**Architecture:** a new `agent/lib/dark-factory/agent-output.ts` exposes an `AgentOutputRecorder` interface plus a per-profile registry. Recording maps the agreed taxonomy onto existing `RunEventType` values where they already fit, adds one new type for roadblocks, and reuses `appendEvent`, `postComment` and the `DF_*` redaction rather than introducing a second store or comment API. The existing `notifying-run-history` decorator is the seam that reacts to a recorded event.

**Tech stack:** TypeScript, Vitest, Postgres (`df_run_events`), the existing dark-factory seams.

---

## Verified reality (what this extends, not builds)

| Surface                                                            | Verified state                                                                                                                                                                                                                                            |
|--------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `appendEvent(event: RunEvent)` (`run-history-postgres.ts:1374`)    | writes `df_run_events`; `UNIQUE (run_id, event_id)` gives idempotency per event                                                                                                                                                                           |
| `RunEvent` (`run-history.ts:97`)                                   | carries `type`, `stage`, `occurredAt`, `commentReference`, `trace`, `testResults`, `status`                                                                                                                                                               |
| **Ledger posture**                                                 | documented as *store the reference, never the text*: `commentReference` is "carried only on `worker.question` events; the ledger stores the reference, never the text", `trace` is "derived, never raw prompts", `testResults` holds "no raw output text" |
| `RunEventType` (`run-history.ts:52`)                               | `worker.progress`, `worker.question`, `worker.completed`, `review.round`, `run.cost`, `run.terminal`, ...                                                                                                                                                 |
| `worker.question` constraint (`run-history.ts:682`)                | **must** carry `status: "blocked"`; `notifying-run-history.ts:38` maps it to `parked`; `plan-approval.ts` already reads it to resume                                                                                                                      |
| `worker-reporter.ts:325`                                           | existing emitter of `worker.question` — the precedent to copy                                                                                                                                                                                             |
| `MAX_COMMENT_CHARS = 60000` (`plan-comment.ts:24`)                 | exported; already reused by `sprint-delivery.ts`                                                                                                                                                                                                          |
| `MAX_GIT_DIFF_CHARS = 65536` + redaction (`diff-capture.ts:17,33`) | inline `DF_*` secrets are replaced with `# [redacted KEY]` before persisting                                                                                                                                                                              |
| `notifying-run-history.ts`                                         | decorator that already reacts to event types (e.g. `worker.question` → `parked`)                                                                                                                                                                          |
| `agent-cli-author.ts`                                              | the Architect's output surfaces here as a CLI stream (`buildAgentCliCommand`), **not** via `console.*` — `architect-agent.ts` has no console calls at all                                                                                                 |
| `app/dark-factory/runs/[runId]` + its route                        | the route already returns `events` for a run (#561 renders it)                                                                                                                                                                                            |

Correction to the epic's framing, recorded honestly: the "~57 console calls" are in `developer-agent.ts` and the runner, **not** the Architect. The Architect's console is the CLI author's stream.

## Settled decisions (from the approved epic)

### 1. The taxonomy maps onto existing event types

| Agreed type                 | Event type                   | Notes                                                                                                  |
|-----------------------------|------------------------------|--------------------------------------------------------------------------------------------------------|
| decision-question           | `worker.question` (existing) | must carry `status: "blocked"` — a validated constraint, not a free choice                             |
| milestone                   | `worker.progress` (existing) | stage boundaries only                                                                                  |
| roadblock                   | **`worker.roadblock` (new)** | `worker.question` cannot carry a non-parked roadblock because the validator forces `status: "blocked"` |
| full transcript / raw shell | **not captured**             | asserted by test, not just documented                                                                  |

Adding `worker.roadblock` means updating the union, the accepted-type allow-list (`run-history.ts:256`) and its per-type validation.

### 2. What the ledger stores — the one open fork

The existing stance is *reference, never text*, but #557 asks for capture "in the database against the run". Proposed resolution: **both, bounded** — the event row carries a bounded, typed, **redacted** summary (the taxonomy plus caps make it a summary, not a transcript), and the readable prose lives on the issue with `commentReference` pointing at it. The ADR records this as a deliberate, documented deviation from the older stance.

*Alternative if you prefer the purer rule:* the row carries only the reference and a machine field, and all prose goes to the issue comment. Slightly less useful in the run view; perfectly defensible.

### 3. Caps and posting

Per item, the text is redacted then truncated to `MAX_COMMENT_CHARS` and marked truncated when it was. Posting uses **one comment per run, updated in place** on retry (the plan-comment precedent), never a comment per event.

### 4. Redaction is not optional

Every captured string passes through the existing `DF_*` redaction first. A capture path that cannot redact does not store.

## Tasks

### Task 1 (RED): the recorder contract

**Files:** create `tests/dark-factory/agent-output.test.ts`; create `agent/lib/dark-factory/agent-output.ts` (signature + `throw new Error("not implemented")` stubs only, so the file collects and the tests fail for the right reason).

Assert: an `AgentOutputRecorder` exposes `record(...)`; a registry resolves a recorder by agent profile; an unknown profile is a typed error, not `undefined`.

### Task 2 (GREEN): the recorder

**Files:** `agent/lib/dark-factory/agent-output.ts`.

Implement redaction-then-cap and the typed record. Tests: each captured type records; transcript/raw-shell do not; an over-cap item is truncated and flagged; a `DF_*` secret in the text is redacted before it reaches the store.

### Task 3 (RED): the roadblock event type

**Files:** `tests/dark-factory/run-event-types.test.ts` (or the existing run-history test), `run-history.ts`.

Assert: `worker.roadblock` is in the union, in the accepted-type allow-list, validates with the fields the recorder sends, and rejects a malformed payload. **Include a valid-value assertion in each rejection case** — a `toThrow()` against a stub passes vacuously.

### Task 4 (GREEN): roadblock end-to-end

**Files:** `run-history.ts`, `notifying-run-history.ts`, `run-history-postgres.ts`.

Tests: a `worker.roadblock` event round-trips through the Postgres store (DSN-enabled, not skipped) and the notifier treats it as notable without parking the run.

### Task 5 (RED): the Architect wiring

**Files:** `tests/dark-factory/architect-agent-output.test.ts`.

Assert: a question observed on the Architect's CLI stream records a `worker.question` with the required `status: "blocked"` and a `commentReference` once posted; a milestone records `worker.progress`; ordinary stream chatter records nothing.

### Task 6 (GREEN): register the Architect

**Files:** `architect-agent.ts`, `agent-cli-author.ts` (or the code-author seam that observes the stream), `agent-output.ts`.

Test: the Architect profile is registered and one real path records exactly the expected events.

### Task 7: the readable comment

**Files:** `agent-output.ts`, reuse of `plan-comment.ts`'s in-place comment helper.

Tests: one comment per run; a second capture **updates** it rather than posting again; the markdown is capped and the reference is stored on the event.

### Task 8: docs, ADR and the drift guard

**Files:** `docs/adr/0082-<slug>.md` (next free number; 0081 is the latest), `docs/adr/README.md` (index row, pinned table formatter), and a `docs/pages/*.md` page that links the new module as a real relative link — the logged path is `agent/lib/dark-factory/agent-output.ts` — because `tests/doc-drift-guards.test.ts` fails on a new `agent/lib/dark-factory/*.ts` that no docs page references. The page's link resolves because the module lands in the same change; the plan itself keeps the path as code rather than a link, since a forward link would fail MegaLinter's link check on a changed markdown file.

## Files likely to change

- create `agent/lib/dark-factory/agent-output.ts`
- modify `agent/lib/dark-factory/run-history.ts` (union, allow-list, validation)
- modify `agent/lib/dark-factory/notifying-run-history.ts`
- modify `architect-agent.ts` + the code-author seam it uses
- create `docs/adr/0082-*.md`, modify `docs/adr/README.md`, a `docs/pages/*.md` page
- create `tests/dark-factory/agent-output.test.ts`, `architect-agent-output.test.ts`; extend the run-history tests

## Validation

- Full DSN-enabled suite: the five `*_TEST_DATABASE_URL` vars set (RUN_HISTORY, CONTROL, COST_BUDGET, TENANT, USAGE), `_DRIVER` vars unset so unconfigured-store tests keep their meaning. Without the DSN the Postgres assertions silently skip and a green run proves nothing.
- `npx tsc --noEmit --incremental false` (a bare run can exit 0 on a stale build-info).
- Local lint gate on every changed file, including the plan: pinned `markdownlint-cli@0.45.0` and `markdown-table-formatter@1.6.1`, plus `cspell` **with the file count asserted** (`--no-must-find-files` plus a bad path is a vacuous pass).
- `npx eve build` once a module is added under `agent/`.

## Risks and open questions

1. **The ledger's "never the text" stance** — decision 2 above is a deliberate deviation; the ADR records the why. Flagged for your explicit choice.
2. **`worker.roadblock` is a new public event type** — it appears in the run view and in any consumer that switches on `RunEventType`. Grep for exhaustive switches before shipping.
3. **Redaction coverage** — the existing redaction targets `DF_*` secrets inside diffs. Agent output can contain other sensitive shapes (tokens echoed in test output). The plan reuses what exists and records the limitation in the ADR rather than implying full coverage.
4. **CLI-stream capture may be lossy** — the Architect's stream is the external CLI's, so the observation point is whatever the code-author seam exposes. If it cannot observe questions without changing the seam, that is a finding to report rather than a workaround to ship.
5. **One comment per run** needs a stable per-run marker to find its own comment; the plan-comment marker pattern is the precedent.
