# 0004 — Story publish is fail-closed

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

A webhook can cause GitHub issues to be created in customer repositories. An
incorrect repository target writes into a customer's tracker — visible, hard to
undo, and damaging to trust.

## Decision

Refuse story creation unless `STORY_ALLOWED_REPOS` is configured, and restrict
`owner/repo` to `[A-Za-z0-9_.-]` characters both before handing it to the
provider and at the boundary. The provider itself refuses creation when the
allowlist is unset.

## Consequences

- A misconfigured deployment creates nothing rather than creating issues in the
  wrong repository. Failure is visible and harmless.
- Enabling the feature is an explicit allowlist action, so it cannot happen by
  accident or by inheriting a default.
- A legitimate new repository needs a configuration change before it works. That
  friction is the point.
