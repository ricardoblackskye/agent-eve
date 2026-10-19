# 0050 — Local Dark Factory runs are provisioned deliberately, not discovered by refusal

- **Status:** Accepted
- **Date:** 2026-10-19
- **Issue:** #404
- **Supersedes:** —

## Context

A local Dark Factory run worked, but every prerequisite was discovered by hitting its refusal: five runs,
one refusal each — a missing env var, an unloaded `.env.local`, a hosted store whose certificate aborted the
park, a sandbox seam that wasn't up, and a parked run that still held its issue's claim. None of these were
written down; each was learned by being refused.

Three of those refusals had a sharper cause than "I forgot to set X":

- The runner (and the sandbox helpers, and the membership/seed scripts) expected `.env.local`, but a bare
  `tsx scripts/dark-factory-runner.ts` never loaded it — so the same variable could be set in one place and
  silently missing in another.
- Discovery reads `process.cwd()`, so a run launched from the wrong directory silently scanned the wrong repo.
- A checkout cloned with a credential in its URL **persists that credential in `.git/config`** — a token found
  on disk after a run.

The remainder (a parked run holding its claim; labels left behind when a run stops) are the subject of #404 R2.

## Decision

A local run is provisioned deliberately:

1. **One launcher asserts every prerequisite and reports ALL of them at once**, in a single block. A missing
   variable is one line of output, not an afternoon of refusals.
2. **Secrets are read at runtime and never printed.** The launcher prints names and presence, never values; the
   runner keeps failing closed on a missing provider key.
3. **A hosted store is refused locally unless an operator opts in by name.** The certificate a hosted store
   presents aborted a park; a local run points at a local store. `--allow-remote-store` is the explicit override
   (ADR 0039 still governs CA trust — verification is never disabled).
4. **The working directory is a per-issue checkout of the TARGET repository**, prepared by the launcher, because
   discovery reads `process.cwd()`.
5. **Authentication is injected through the git environment** for the single clone invocation, so the checkout's
   `origin` URL never carries a credential and argv never shows one.
6. **The runner loads `.env.local` like every other operator script**, so a direct invocation behaves like the
   launcher-driven one.

Retiring a stale claim, and reconciling the labels a dead run leaves behind, are **deliberately R2** — they
change the ledger's API surface and need their own design.

## Consequences

- A local run is one command (`npm run df:local-run -- --repo owner/repo --issue N`) and a missing prerequisite
  is one readable block.
- What was discovered by refusal is now explicit and tested: the preflight is a pure function over
  `(env, target, probes)`, so the whole chain is testable without a database, a cluster, or a network.
- The launcher is the single source of the requirement list and **must track the runner**: a prerequisite the
  runner gains must be added to the preflight, or a local run will pass the launcher and fail inside the runner.
- A parked run still holds its claim until R2; a clean re-run on a parked issue is refused with the holder named
  (R2 gives that refusal a one-line fix).
