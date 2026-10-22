# 0053 — The AMM scanner's command set comes from its catalogue, not the shared test list

- **Date:** 2026-10-22
- **Status:** Accepted

## Context

Two callers execute commands inside the same isolated sandbox driver, and they have
legitimately different command sets. The Developer Agent's coding loop runs tests, so the
driver enforced one shared constant, `ALLOWED_TEST_COMMAND_PREFIXES`
(`npx vitest`, `npm test`, `npx tsc`), deliberately shared with the loop so two copies could
not drift.

The AMM scanner has a different job: its catalogue (`amm-signals.ts`) defines five `command`
checks — `npm run lint`, `npx tsc --noEmit`, `npm run validate`, `npm ci`,
`npm run test:unit` — and four of them are outside the shared list. Wired to the driver, those
four were refused as `InvalidTaskError` and came back `unmeasured`, so wiring the sandbox in
changed nothing for four rows out of five.

The obvious repair — add the scanner's commands to the shared constant — is a one-line change
that widens what the *Developer Agent* may execute, `npm ci` included, which runs a
repository's lifecycle scripts. Two callers with different needs do not share one permission.

## Decision

The isolated driver accepts an OPTIONAL per-call allowlist, and the AMM scanner passes its own,
derived from the catalogue rows whose check kind is `command`. The Developer Agent's shared
constant is left untouched, and a caller that passes nothing gets exactly today's behaviour.

The scanner still refuses to run anything unless the provider reports `isolated: true`, so the
allowlist widens *what* may run, never *where*.

## Consequences

- The Developer Agent's blast radius is unchanged, and the guard test that pins it fails if
  someone later folds the scanner's commands into the shared list.
- The catalogue becomes the single source of truth for what a scan may execute: adding a
  `command` row to the catalogue is what permits it, and there is no second list to keep in
  step. That is the intended shape — the catalogue already owns what the scanner checks.
- The driver now has two ways to be told what it may run, which is one more path to review when
  the sandbox's permissions are audited. The default is the narrow one, so the extra path is
  opt-in rather than ambient.
- An allowlist is a permission, not a safety proof: a catalogue row is trusted because it is
  authored in this repository, and a scan of an untrusted repository still executes only those
  five commands inside an isolated sandbox.
- The wider set made the sandbox's own limits visible — `npm ci` needs registry egress, and a
  command that cannot reach the network reports `unmeasured` rather than `absent`, so a
  repository is never marked down for our sandbox's isolation.
