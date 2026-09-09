# Fix: Product Owner live story creation was silently dry-running (#85)

> **Issue:** regression surfaced via live test on issue #85 — webhook fired
> (`eveApiResult: "accepted"`) but **no `[Story]` issue was created and no
> clarifying comment was posted**.
> **Branch:** `fix/story-issue-live-write`
> **Base:** `origin/main` (post R1 merge, `548d212`)

## Root cause (verified)

The R1 `issues` webhook branch in `app/api/github/webhook/route.ts` correctly
detects the trigger, builds a message, and POSTs it to `/eve/v1/session`, which
accepts the Product Owner session. The session then runs `draft_user_story`
and (on `complete`) `publish_story`.

But `publish_story` **defaults to `provider: "console"` (dry-run)** by design —
the GitHub write path is opt-in (`provider: "github"`). The webhook message
only said *"creating a linked story issue on GitHub"* and relied on the agent
to remember to pass `provider: "github"`. It did not, so the story was drafted
and **dry-run** — nothing was written to GitHub, and no error surfaced to the
user (dry-run returns `ok`, not an error).

Proven by: searching the repo for any `[Story]` issue → `total_count: 0`; issue
#85 has `needs-story` label, 0 comments, open. The trigger + agent chain works;
only the final write was skipped.

## Why this is the right fix (not "flip the default to github")

Two safe-by-design properties we want to keep:
- `publish_story` must stay a dry-run-by-default tool so it is safe to call from
  any context without side effects.
- The **webhook's issues flow** is the one place we explicitly want a live
  linked issue. So the fix belongs at the *call site* (the webhook message), not
  by changing the tool's default for everyone.

## Changes

- `app/api/github/webhook/route.ts` — the Product Owner task message now gives
  explicit numbered steps: (1) `draft_user_story`; (2) on `needs_clarification`
  → `comment_questions` with `owner`/`repo`/`issueNumber` then STOP; (3) on
  `complete` → `publish_story` with `provider: "github"` and
  `sourceIssueNumber` so a linked `[Story]` issue is created. Explicitly tells
  the agent NOT to use the console dry-run default.

No change to `publish_story`, the provider, or the trigger detector.

## Verification

- `npx tsc --noEmit` — clean
- `npx vitest run` — full suite green (no new tests needed; behaviour is an
  agent-instruction change exercised only by the live flow)
- **Live re-test (the real gate):** after deploy, open a new issue with the
  `needs-story` label (or mentioning `@eve-agent`). Expect either:
  - a new `[Story] <title>` issue created, body linking back to the source, OR
  - a clarifying-question comment on the source issue (if the draft was vague)
- Check webhook **Recent Deliveries** for the `issues` event → 200 with
  `eveApiResult: "accepted"`.

## Prerequisites already confirmed

- `GH_STORY_TOKEN` set in Vercel (Production) with `public_repo` scope — sufficient
  for issue creation on the public `agent-eve` repo (the scope probe now accepts
  `public_repo`; that fix is a separate follow-up commit on `feat/user-story-core-61`).
- GitHub webhook subscribed to **Issues** (was `pull_request` only; extended during
  the R1 live test).
- `EVE_API_KEY` present (webhook returned `accepted`, not `skipped`, so the agent
  was invoked).

## Follow-ups (not in this branch)

- Land the `public_repo` scope-probe fix currently parked on
  `feat/user-story-core-61` (commit `01e4e09`) via its own PR.
- Consider a CI/eval that posts a signed `issues` webhook and asserts a `[Story]`
  issue appears — currently only the PR/ping paths are covered by evals.
