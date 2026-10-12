# 0025. Filter the environment handed to child processes

**Status:** Accepted
**Date:** 2026-10-12
**Issue:** #275

## Context

`child_process.exec`/`execFile` INHERIT the parent environment when no `env` option is
passed. In a deployed Dark Factory runtime that environment holds the operator's GitHub push
token, every `DF_*` knob and any database URL. So any command an agent shells out to could
read all of it.

Two agents shell out. The **tester agent** filtered the child environment from the start.
The **developer agent** did not: its test runner called `execAsync(cmd, { cwd, maxBuffer })`
with no `env`, so its child inherited everything. This is the "verify dev-agent env filtering
like tester-agent" gap named in #275. Its command-injection surface was already well defended
(metacharacter denylist, token allowlist, command-prefix allowlist), so the exposure was not
arbitrary command execution — it was the child process READING the parent's secrets.

## Decision

Filter the environment handed to EVERY child process through one shared allow-list
(`child-env.ts`), consumed by both agents. Keep the list minimal; add a key only with
evidence that a child genuinely needs it.

## Consequences

- Changing what a child may see is now a ONE-place edit, and its absence is a visible
  failure rather than a silent drift between two agents.
- A new agent that shells out must import the filter; a source-level guard in
  `tests/dark-factory/security-validation.test.ts` fails if the developer agent's `exec`
  call site stops passing `env`, so the control cannot be quietly unwired.
- Only the KEY SET is restricted — values are passed verbatim, not scrubbed.
- Unknown keys are dropped, so a typo in an allow-listed name fails closed.
