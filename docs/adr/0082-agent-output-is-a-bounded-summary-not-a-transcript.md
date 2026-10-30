# 0082 — Captured agent output is a bounded, redacted summary in the ledger

- **Status:** Accepted
- **Date:** 2026-10-30

## Context

Epic #557 asks that each Agent's notable output be captured, posted as a readable
item on the ticket, and stored against the run. Two existing shapes constrain how.

The run ledger has a deliberate posture: **store the reference, never the text**.
`commentReference` is documented as carried "only on `worker.question` events; the
ledger stores the reference, never the text"; `trace` is "derived, never raw
prompts"; `testResults` holds "no raw output text". The reasoning is that a ledger
of raw model output would be large, mostly noise, and a place secrets leak into.

`worker-reporter.ts` already owns the posting path: a canonical, provider-agnostic
`WorkerMessage` ("fields, not free prose"), record-first-fail-closed ordering, one
rolling comment per run idempotent by `(runId, kind)` — a retry EDITS, never
duplicates — and its own bounds (`MAX_QUESTION_CHARS = 2000`, test evidence lines
and characters, attempt). Output is the expensive side of a model call, so
capturing a transcript is costly as well as unreadable.

## Decision

Capture a deliberately small, typed set and route it through the existing seams:

1. **Three types only** — decision-question, roadblock, milestone — mapped onto
   existing run-event types where they fit (`worker.question`, `worker.progress`)
   and one new type for roadblocks (`worker.roadblock`), because `worker.question`
   is validated to carry `status: "blocked"` and is what the park/resume path reads,
   so a recoverable roadblock cannot borrow it.
2. **The ledger stores one bounded, redacted summary** plus the comment reference.
   This is a deliberate, documented exception to "never the text". It is defensible
   only because the taxonomy and the bound make it a summary rather than a
   transcript: a single string, capped at `MAX_AGENT_OUTPUT_CHARS` (2000), redacted
   before it is stored, and refused outright when empty.
3. **The recorder adopts its consumer's bound.** The bound equals the reporter's
   `MAX_QUESTION_CHARS`, because a longer summary is a message the reporter refuses.
   The ledger cannot import that constant (`worker-reporter` imports `run-history`,
   so that would be a cycle), so a test asserts the two constants are equal. One
   authority over the same input, kept in step by a guard rather than by hope.
4. **No new comment or store path.** The recorder prepares, bounds and redacts; the
   reporter records and posts. Posting semantics — including updating in place —
   are unchanged.
5. **Redaction reuses the diff sanitiser** (`sanitizeDiff`), rather than adding a
   second redaction implementation.

## Consequences

- A run's notable output is readable both on the ticket and against the run itself,
  which is what #557 asked for, without the ledger becoming a transcript store.
- The ledger's "never the text" rule now has exactly one bounded exception. A future
  reader can see its extent from the constant, the validator, and the equal-bound
  guard.
- **The redaction guarantee is narrower than the word suggests.** The reused
  sanitiser rewrites env-file style `DF_*` assignments — at a line start, optionally
  behind a git diff prefix — and does **not** rewrite a secret echoed mid-sentence,
  nor a non-`DF_` variable. This was established by probing the function's
  behaviour, not by reading it. A test pins that boundary so nobody infers full
  coverage; widening it is separate work.
- `worker.roadblock` is a new public event type and `roadblock` a new message kind.
  At the time of writing nothing switches exhaustively over either, so the widening
  is additive.
- A summary over the bound is refused at the ledger boundary, not silently
  truncated: the recorder truncates first and flags it, so an over-long value
  reaching `toRunEvent` is a caller bug.
