# 0029 — The code author is a fail-closed, configuration-selected seam

**Date:** 2026-10-13
**Status:** Accepted

## Context

The Dark Factory runner authored code inline: build a prompt, make a cost-governed `streamText` call,
regex-extract a JSON object from the response, then write the files into the workspace. Epic #279
(Model B) moves authoring into a coding-agent CLI running inside a sandbox, which means the thing that
writes the code becomes a *choice* rather than a fixed path.

That choice needs a seam for the same reason the execution backend did (#280): without one, every
later release would have to change the developer loop itself.

## Decision

Introduce `CodeAuthorProvider` with a **fail-closed** switch, `DF_CODE_AUTHOR`:

- **Absence means today's behaviour.** Unset or blank resolves to `in-process`, which is the existing
  prompt, model call and JSON extraction, carried over verbatim and pinned byte-for-byte by test. A
  silent prompt change would alter what the model is asked to do, which a zero-behaviour release must
  never do.
- **There is no boolean flag.** A boolean can default open; a named author cannot.
- **An unknown value throws**, naming the supported authors.
- **`agent-cli` refuses when its dependencies are absent**, rather than falling back to `in-process`.
  A silent downgrade would contradict an explicit operator choice and hide the gap behind a green run.
- **The seam does not write files.** It returns the authored map and the caller writes it, which keeps
  the seam pure and leaves the workspace guards on the existing path.
- **A failed CLI run is never authored code.** A non-zero or unreadable exit status is a failure.
- **The CLI receives a lease, never the provider key** (see #0030), and its exact invocation stays
  operator-supplied because flags and non-interactive behaviour vary by CLI version.

## Consequences

- With the switch unset, R2 changes no behaviour, and the full suite passes unchanged.
- The sandboxed author cannot be armed without its governance: the adapter is built only when its
  dependencies (including the gateway lease) are supplied.
- The untestable part is deliberately tiny and explicit: one operator-supplied command template,
  rather than guessed CLI flags buried in code.
- Every new author implementation must satisfy the same contract tests, so the two backends ask the
  same question of the same prompt.
