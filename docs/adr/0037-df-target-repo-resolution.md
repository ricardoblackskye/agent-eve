# 0037 — A run's target repository is RESOLVED from config and AUTHORIZED by an allow-list

- **Date:** 2026-10-16
- **Status:** Accepted

## Context

Issue #348: a Dark Factory run worked on exactly one repository, because the runner assigned
`const targetRepo = "ricardoblackskye/agent-eve"` and every repo-wide reference derived from it. The
repo itself was never the problem — the webhook already reads `repository.full_name` from the payload,
the DF trigger already carries it, and `credentials.ts` already owned both the repo-pair pattern and a
fail-closed allow-list parser. What was missing is that the **runner** was never told which repository
it was for.

The runner also **defeated its own gate**: it set `DF_WORKER_ALLOWED_REPOS` when the variable was
unset, so `resolveWorkerAllowedRepos` (which returns `[]` for an unset variable, meaning *refuse
everything*) never saw an unconfigured deployment. The gate existed and could not fire, while the
target it guarded was invented. Two bugs compensating is not a design.

The user's steer: *"the app should have a default repo in config but when it's called then it should be
by the project ⇒ repo that the issues are in."*

## Decision

- **Resolution and authorization are separate questions, answered in one module
  (`runner-config.ts`).** Resolution decides *which* repository a run is for; authorization decides
  *whether we may touch it*.
- **Resolution order:** an explicit `--repo` wins, else `default_repo` from
  `dark-factory.config.json`, else the run **refuses**. Every candidate is validated against the
  existing `REPO_PAIR_PATTERN`, and normalised only in resolution, so identity is decided in one place.
- **The default lives in config, never in code.** A default in code is indistinguishable from the
  hardcode this issue removes; in config it is a stated operating choice, reviewable in a diff, and
  overridable without a deploy.
- **Authorization is unchanged and now actually reachable:** `DF_WORKER_ALLOWED_REPOS`, fail-closed,
  with the runner no longer setting it. An unset list refuses every repository by name.
- **The target is the issue's own repository.** The Project relationship is *not* the authority for the
  repo: a Project item can reference an issue in any repository, so the Project states the target less
  precisely than the issue itself. The Project matters for which **board** a run reports to (R2).
- **The runner's other invented inputs go the same way:** `--issue` was required to become explicit (it
  defaulted to `179`), digits are matched rather than passed to `parseInt` (which coerces `"34.8"` to
  `34`), and the branch default loses the `#` that breaks GitHub URLs.

## Consequences

- **A deployment must set `DF_WORKER_ALLOWED_REPOS` or every run refuses** — intended fail-closed
  behaviour, and a behaviour change worth naming. The runner and the deployed webhook are *different
  processes*, so the variable is needed in each; the deploy-time one was already required before this
  decision (the trigger was always fail-closed) and is therefore not a new requirement.
- A misconfigured or too-narrow allow-list now fails **before** anything is cloned or written, with a
  message naming the repository and the list, instead of failing later at clone or PR time.
- A badly-typed config is refused rather than read as text: `default_repo` is validated by type as well
  as by value, because a `RunnerConfig` built in code never passes through the loader.
- **Cost: two config files now describe repositories** (`release-manager.config.json` for release
  settings, `dark-factory.config.json` for the Factory). They share a shape, and both key on
  `owner/repo`, but drift is possible — if their fields converge they should merge.
- Deferred to R2: per-repo settings (board, allowed actors, branch prefix) and the
  remaining single-repo fallbacks in the webhook prompts and release-manager tools.
