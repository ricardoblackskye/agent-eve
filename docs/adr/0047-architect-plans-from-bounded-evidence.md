# 0047. The Architect plans from bounded evidence, not from a file list

**Status:** Accepted

**Date:** 2026-10-18

## Context

The Architect received a repository file LIST and nothing else, so it could not tell a page from a shared
component from the application shell. Two live runs failed on exactly that. On WebFeedPOC #166 a story
saying "the main page" was planned against a component shared by two pages; on #168 round 2 the target
moved to the application SHELL, with a confident rationale manufactured for it. The second failure is the
instructive one: a file list cannot distinguish a file rendered on every route from the page a story names,
and an Architect given no evidence does not report the gap - it invents a reason.

`ArchitectDeps.readFile` had been declared since the agent was written and called from nowhere. The runner
could read the checkout; the agent was never given a way to.

## Decision

The Architect reads file CONTENTS within a budget it cannot exceed, and cites what it read.

1. **Discovery is deterministic.** The route table is parsed and the component each route renders is
   resolved through that file's own imports; a file rendering a route outlet is a SHELL; a component
   reached from more than one page is SHARED, and its evidence NAMES those pages. No model call is made, so
   cost stays exactly one governed call per plan attempt - the property a test pins.
2. **The reader fails closed on four axes.** An unsafe path is refused BEFORE the filesystem is touched, so
   an escape is not caught but never attempted. Truncation is on a LINE boundary and reported, with the
   file's real length, because a fragment presented as a whole file is worse than no file. The character
   budget is enforced ACROSS the read set, not per file. The cache is load-bearing: discovery and the prompt
   read the same files, and charging them twice would silently halve the budget.
3. **The budget covers the whole prompt and is derived, not hard-coded.** The context window is a property
   of the model, looked up by resolved model id with a conservative fallback for an unknown one. The
   default 400,000 characters is deliberately sized against the SMALLEST window in use, so it is safe
   whichever model resolves - which matters because the runner and the resolver currently disagree (see
   #400). The instruction block is checked against the budget before any read or model call and REFUSED if
   it cannot fit; the reading section receives what remains, with the heading and the omission notice
   reserved before a single file is admitted.
4. **Evidence travels with the contents and omissions are stated.** Each block carries the path, the role,
   the truncation state and the composition path that proves the role - "renders an outlet, so it is
   rendered on every route" is checkable, "shared component" is not. The prompt requires each targetFiles
   rationale to cite that evidence, and instructs the model to treat omitted files as UNKNOWN rather than
   irrelevant. File contents are escaped and labelled as untrusted data.

## Consequences

R1 makes a better target likely. R2 makes the right target required, by excluding shell and shared files
from the target set and parking the run when no page can be justified.

Two limitations are recorded rather than hidden. Discovery is calibrated to a router that declares its
routes, so a framework whose routes are implied by file paths resolves no chain - measured on this
repository: 718 files listed, no chain, and the roles found were the shared components reached from several
API routes. And the repair prompt does not carry the evidence section, so a retry re-plans from the file
list and the validation feedback alone; the budget is enforced on the initial prompt.

The Architect's input grew from about 15,000 characters to about 87,000 on this repository, 21.9% of the
budget, still one model call.
