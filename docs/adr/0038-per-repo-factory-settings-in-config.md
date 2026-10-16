# 0038 — Per-repo Factory settings live in config, not in the database

- **Date:** 2026-10-16
- **Status:** Accepted
- **Supersedes:** nothing. Related: 0037 (the target repository is resolved, not hardcoded).

## Context

0037 made a run's **target repository** a resolved, authorized input. #348's second half is about the
settings that *depend on that repository*: which Project board a repo's work is reported to, and the
owner/repo a story is filed against.

Those values were literals. The sharpest one was not a fallback at all: the sprint reporter defaulted the
board to **number 3 for every repository but one**, the webhook then told an agent to use it, and the
backlog provider carried `ricardoblackskye`/`agent-eve` behind an `||`. A wrong value stated confidently
is worse than a missing one — a fallback is only wrong when it is used, an instruction is followed.

The umbrella issue #367 asks this question directly: *"There should be work done to have
these either set in config or by the database."*

## Decision

- **Settings live in `dark-factory.config.json`**, beside `default_repo`, with a `repos` map keyed by
  `owner/repo` (validated with the same `REPO_PAIR_PATTERN` as everything else).
- **One resolution order, per half:** an explicit argument, then an existing environment override
  (`SPRINT_PROJECT_OWNER`/`SPRINT_PROJECT_NUMBER`, `VERCEL_GIT_REPO_OWNER`/`SLUG`, `GITHUB_REPO_OWNER`/
  `NAME`), then the repo's config entry, then **a refusal naming the repository and the file**.
- **The Project decides the BOARD, not the repository.** The repository is the issue's own (0037). A
  Project item can reference an issue in any repository, so the Project states the target less precisely
  than the issue does — but it is exactly the right identity for *where work is reported*.
- **A default that must exist is sourced from config, never restated in code.** The backlog provider keeps
  its documented default (a test asserts it, and `STORY_ALLOWED_REPOS` bounds where a story may land) but
  reads that value from `default_repo`.
- **Not the database**, for four reasons in order of weight: these are operator *intent* rather than runtime
  state, and the database here holds what *happened* (runs, events, usage) and authorization *records*;
  config is reviewable and versioned in the same pull request as the code that reads it, while a row is
  invisible in a diff; this repo has **no automatic migrations**, so a database setting buys a manual
  per-environment step for something a checked-in file gives for free; and a missing config key fails at
  load in one place naming the file, where a missing row fails at use in whichever feature read it.
- **The database remains right for anything needing an audit trail** (who changed what, when). If a
  settings change ever needs that, it is a deliberate follow-up with its own ADR — not a default.

## Consequences

- **A repository with no board configured now refuses**, naming itself and the file, where it previously
  reported to board 3. `agent-eve` gets an explicit entry, so its behaviour is preserved *deliberately*
  rather than inherited, and a test loads the real file to pin it.
- Every consumer resolves through **one module**, so precedence, validation and the refusal cannot drift
  between the sprint reporter, the release-manager tools and the backlog provider.
- `env-example-coverage` had to keep passing: the tools pass env **values**, not variable names, so the
  variables stay visible in the source. That test was right to fail on the first attempt.
- Two config files now describe repositories — `release-manager.config.json` (release settings) and
  `dark-factory.config.json` (Factory settings). They share a shape and both key on `owner/repo`, but drift
  is possible; if their fields converge they should merge. ADR 0037 already records this cost.
- Deferred: the tenant axis is untouched. Tenants govern **who may see** data; a repository governs **what
  work is done**, and conflating them would put a per-repo decision behind a per-viewer one.
