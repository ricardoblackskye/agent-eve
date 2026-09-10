# Release Notes

## Unreleased

### CI/Infrastructure

- [PR #104]: feat(ci): run unit tests (vitest) on every PR and push to main — adds automated unit test execution in CI via a new `unit-tests` job and `npm test` script, ensuring test failures block merges and catch regressions early (Issue #103)

## v0.2.2 (2026-08-30)

### Features

- [PR #98]: feat(story): Add parent-link to generated story issues — when creating a new `[Story]` issue, the GitHub provider now adds a parent link back to the source issue in the story issue's body, providing bidirectional traceability between the feature request and the generated story (Issue #61)

### Bug Fixes

- [PR #98]: fix(story): Option B dedup guard prevents duplicate story creation — before creating a `[Story]` issue, the GitHub provider now checks the source issue's comments for an existing `📄 User story generated…` marker and skips creation (returns `duplicate: true`) if one is found; closes the gap Option A left where a partial-failure run that created a child but never applied the `user-story-added` label would otherwise mint a duplicate on re-trigger (Issue #61)

## v0.2.1 (2026-08-29)

### Bug Fixes

- [PR #95]: fix(story): prevent duplicate user-story issues via completion-label dedup guard — adds a dedup guard to the user-story trigger so re-adding the `needs-story` label (or a duplicate/racing label event, or a re-edit still matching the `@eve-agent` mention) to an issue that already has a generated story does not create a second `[Story]` issue

## v0.2.0 (2026-08-28)

### Features

- [PR #90]: Further refinement of the backlog creation process — enhances the story refinement pipeline with improved backlog generation workflows and better integration with the Product Owner subagent (Issue #61)
  - Phase 3 & 4 backlog integration: child-link comment posting on source issues when stories are generated
  - Label transitions via `finalizeLabels` helper for Phase 4 workflow
  - GitHub provider now returns created issue numbers and links child stories with label transitions
  - Skip duplicate clarifying comments on re-apply (Phase 3 idempotency)
  - Regression guards for no-re-trigger + `publish_story` surfacing
- [PR #84]: R1 user-story generation loop (Product Owner subagent) — implements a Product Owner subagent that drafts structured, AI-ready user stories from GitHub issues and creates linked story issues when the request is clear; includes deterministic, unit-tested core libraries (story-schema.ts with Zod schema and NFR defaults, story-refinement.ts with gap detection) mirroring the existing pr-reviewer/release-manager subagent pattern (Issue #61)

### Bug Fixes

- [PR #90]: Fixed product-owner subagent default model from retired nemotron to deepseek-v4-pro
- [PR #90]: Fixed label transition logic — `finalizeLabels` now describes transitions rather than using hard-coded current labels
- [PR #90]: Made finalization idempotent (avoids duplicate child-link comments)
- [PR #88]: Fix token-scope probe to accept public_repo scope for issue creation on public repos — the probe only accepted repo/issues:write, incorrectly rejecting GH_RELEASE_TOKEN with public_repo scope; public_repo is sufficient for issue/PR comment writes on public repositories per GitHub community guidance; includes regression tests covering public_repo, repo, issues:write, and write:discussion-only scopes

## v0.1.2 (2026-08-27)

### Bug Fixes

- [PR #81]: Fix preview evals triggering on production deployments — previously preview-evals.yml ran on every deployment_status including production, causing 401 failures against Vercel Authentication and leaving red checks on main after merges (Issue #79)

- [PR #81]: Fix release notes workflow failing silently — now surfaces failures properly for easier diagnosis (Issue #80)

- [PR #83]: Fix production evals webhook signature regression — production evals posted unsigned payloads and asserted success; after webhook signature enforcement (PR #77), `verifySignature` correctly rejects unsigned requests with 401, so evals now sign payloads properly (Issue #82)

## v0.1.1 (2026-08-26)

### CI/Infrastructure

- Remediate the initial MegaLinter findings with scoped spelling/link configuration, safer copy-paste thresholds, immutable action pins, and read-only workflow permissions

## v0.1.0 (2026-08-25)

### CI/Infrastructure

- [PR #29]: MegaLinter pipeline integration — adds automated code quality, spelling, YAML/JSON/markdown linting, copy-paste detection, and GitHub Actions security auditing to CI