# 0056 — Planning refuses a workspace it cannot justify

- **Date:** 2026-10-23
- **Status:** Accepted

## Context

The Architect's discovery read whatever `process.cwd()` happened to be. The local launcher clones the
target repository into a per-issue workspace and spawns the runner there, so a launcher-driven run
was correct — but only because of where the launcher put the child process. Nothing in the runner
asserted it, and the Architect's `listFiles(dir)` seam accepted a directory that the runner replaced
with `process.cwd()`.

The failure this produced was not a crash. A run against WebFeedPOC planned against `agent-eve`: the
refusal was correct behavior on the wrong input, R1's evidence described a repository nobody asked
about, and every page-scoped story parks because its surface cannot be found in a repository that
never contained it. A wrong plan is worse than no plan, because it arrives with numbers attached and
reads as evidence.

## Decision

Planning requires a workspace whose identity has been established, and refuses otherwise.

The identity evidence is the checkout's `origin` remote, not its path: a path says where a directory
is, a remote says which repository it is. The candidate resolves from `--workspace`, then
`DF_PLAN_WORKSPACE`, then the working directory, and is accepted only when its remote resolves to the
target `owner/repo` (https, ssh and scp forms all accepted; a trailing `.git` and case differences
tolerated). An explicit choice selects the candidate — it does not skip the check.

A refusal stops the run before any planning token is spent, and names the directory, the repository it
actually is, and the two ways to fix it.

The Architect's reader is rooted at the accepted path, and a path that escapes the root is refused
rather than clamped, so the seam cannot be used to read outside the repository it was given.

## Consequences

A misconfigured run now fails loudly instead of planning about the wrong repository. The cost of that
is a new refusal in a place that previously "worked": a run started from a directory that is not a
checkout of the target, or a checkout whose remote was removed or renamed, will not proceed. The
message names the override, so an operator who knows better can point at the right checkout, and the
check still applies to it.

The deployed worker is subject to the same rule. If it plans from a directory that is not a checkout
of the target, it starts refusing — deliberately, since the alternative is that its plans silently
describe a different repository and no operator can see it from the output.

Cloning inside the runner remains out of scope. The launcher already clones before spawning, and a
direct invocation is expected to supply a checkout; moving the clone into the run lifecycle is a
larger change to when a run becomes visible, and this decision only requires that the input be
correct.
