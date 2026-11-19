# 0091 — The agent-output capture bound is shared with the reporter

- **Status:** Accepted
- **Date:** 2026-11-19
- **Issue:** #698

## Context

The agent-trace capture (`agent-output.ts`) bounded every captured item at `MAX_QUESTION_CHARS` - 2000 -
with the reason written beside it: the captured text is handed to the worker reporter, which
**hard-rejects** anything longer, so a larger capture bound "would hand it something it refuses". That
coupling was deliberate and correct; the constant was simply too small for its second job.

A real run makes the cost concrete. Run `e626dc1e` (WebFeedPOC#200) planned, parked for approval,
resumed, coded and opened PR #201 - and the details page shows the panel headed "AGENT TRACE" with
nothing in it but the acceptance-criteria matrix. The agent output that does exist (#558's seam) is
truncated to a fragment, because a substantive turn is longer than a question.

## Decision

There is **one authority over this input**, and it moves as one. The bound is raised to **8000** for both
the capture and the reporter's limit; raising either alone is a bug, not a tuning choice.

A bound still exists. `PreparedAgentOutput.truncated` continues to say when it bit, so a partial capture
is visible rather than silent. The larger bound applies to worker questions too - accepted deliberately:
the limit is a sanity bound on one rolling comment, not a protocol requirement.

ADR 0082 is unchanged. This remains a bounded, redacted **summary**, never a transcript, and the
redaction guarantees (and their stated boundary: a secret echoed mid-sentence is not rewritten) are
untouched.

## Consequences

- The trace panel can hold what an agent actually produced, which is what makes it worth showing.
- Anyone raising this bound in future must raise it in one place and check both consumers; the comment
  on the constant says so, and this ADR is why.
- Question text may now run to 8000 characters before the reporter objects. If that proves too permissive
  for a ticket comment, the fix is to split the two bounds properly - give the capture its own limit and
  teach the reporter to accept it - which is a larger change than this one and is not made here.
- Full reasoning transcripts remain out of scope: they need either a superseded ADR 0082 or an
  OpenTelemetry exporter plus a retention decision.
