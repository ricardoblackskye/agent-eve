# A conflicting create returns the existing resource

Date: 2026-11-24
Status: Accepted

## Context

The factory creates resources it does not exclusively own the right to create: it opens a pull request for
an issue branch, and it posts comments. A **re-run** of an issue therefore asks for something that may
already exist. The provider answers the conflict with a client error - GitHub returns 422 to a pull request
create whose head already has one - and the factory read that error as a failure of the run.

The cost was concrete: a re-run of an issue whose first run had opened a pull request reached the
Definition of Done, was refused, and reported no verdict at all. The work was fine, the pull request was
open, and the run could not say so.

## Decision

**Creating a resource that already exists is a success that returns it.** When a create is refused as a
conflict, the factory looks the resource up and, if it exists, reports success with it - the same shape a
successful create returns, so every caller continues along one path instead of branching on how the
resource came to be there.

Two conditions bound it:

- the lookup must **prove** the resource exists. A conflict with nothing behind it remains a failure.
- the refusal **carries the provider’s own message**. A bare status code is what made this take a live
  run to notice, and a payload problem must be diagnosable from the log.

## Consequences

- A re-run continues instead of refusing, which is the case re-running exists for.
- Two runs racing to create the same resource converge: the loser resolves to the winner’s.
- The failure path is slightly longer, and carries a body excerpt, so a genuine conflict of a different
  kind is still visible.
- This is stated for a create whose conflict is identifiable. A provider that reports conflicts only as a
  generic error needs its own lookup condition rather than a blanket forgiveness of that status.
