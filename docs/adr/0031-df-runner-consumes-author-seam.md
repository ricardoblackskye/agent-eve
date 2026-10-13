# 0031 — the runner consumes the code-author seam (fail-closed)

**Date:** 2026-10-13
**Status:** Accepted

## Context

R2 shipped the `CodeAuthorProvider` seam and the `in-process` / `agent-cli` adapters, but the runner
still authored code inline and called none of them. A seam with no caller is dead code, and the
`in-process` default had to remain behaviour-identical — a wiring change that altered the prompt or the
parse would be a silent regression.

## Decision

The runner resolves `createCodeAuthorProvider(process.env, { generate })` and calls `author.write`
through the new `authorFiles()` helper, which writes the returned map via the SAME workspace tools as
before. `generate` is the existing governed `runGovernedAgentCall`, so the in-process adapter cannot
bypass the cost gate. `DF_CODE_AUTHOR` unset == `in-process`, byte-for-byte the prior path. `agent-cli`
is armed only when its dependencies are supplied; otherwise the factory refuses rather than degrading.

## Consequences

- Zero behaviour change when the switch is unset; the full suite passes unchanged.
- The inline authoring path is gone; any future prompt change must go through `buildCodeAuthorPrompt`,
  which both adapters share, so the two backends ask the same question.
- A failed author propagates as a failed iteration instead of silently writing nothing.
