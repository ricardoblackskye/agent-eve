# Update README with GitHub→Vercel webhook flow for PR code review (#41)

> **For Hermes:** Use test-driven-development (RED → GREEN → verify). Two human
> gates: plan approval (Phase 3) and PR authorization (Phase 6).
> Resumes the earlier `docs/update-readme-webhook-flow` attempt: that branch
> committed a plan + the RED test but never wrote the README (GREEN). This run
> completes it on a clean branch.

## Goal

Update `README.md` to document how to configure the GitHub → Vercel webhook that
drives the PR code-review workflow and the release-notes automation (issue #41).
The user also wants this README change to be the PR that **exercises the
code-review flow end-to-end** — i.e. proves the PR reviewer now posts a real
AI review (deepseek-v4-pro via MODEL_NAME, per #47/#48) instead of the
"Automated PR Review (Fallback Mode)" comment.

## Root cause (verified, Phase 1)

- `README.md` has **no** webhook section. The "Configuration" / "Deployment"
  sections mention `OPENROUTER_API_KEY` and `EVE_API_KEY` only. There is no
  documentation of:
  - the webhook endpoint `app/api/github/webhook/route.ts` exposes,
  - the `GH_WEBHOOK_SECRET` it verifies,
  - the `GH_RELEASE_TOKEN` the release-manager tools use to write `releasenotes.md`,
  - subscribing to **Pull request** events,
  - the `release-manager.config.json` mapping repos → webhook secret env + notes path.
- The webhook is what connects a GitHub PR event to the agent (release-notes +
  PR review). Without it documented (and without it configured in repo Settings),
  the flow is invisible/undiscoverable. This is a docs gap, not a code bug.
- A prior branch `docs/update-readme-webhook-flow` already committed the plan and
  a RED test (`tests/readme-webhook.test.ts`, 5 assertions) but stopped before
  writing the README. This run finishes it.

## Intended fix (minimal, docs only)

Add a new **"## GitHub Webhook (PR Code Review & Release Notes)"** section to
`README.md` covering:

1. **Endpoint** — `https://<your-deployment>.vercel.app/api/github/webhook`
   (asserted by test: contains `/api/github/webhook`).
2. **Content type** — `application/json`.
3. **Secret** — `GH_WEBHOOK_SECRET` (asserted: contains `GH_WEBHOOK_SECRET`).
   Set the same value in (a) Vercel env and (b) the GitHub webhook Secret field.
   Verified in `app/api/github/webhook/route.ts`
   (`process.env[repoConfig.webhook_secret_env]`).
4. **Events** — subscribe to **Pull request** events (asserted: contains
   "pull request").
5. **Release token** — `GH_RELEASE_TOKEN` (asserted: contains `GH_RELEASE_TOKEN`),
   used by `agent/subagents/release-manager/tools/write_release_notes.ts` to push
   `releasenotes.md` on merge.
6. **Config file** — link to `release-manager.config.json` (asserted: contains
   `release-manager.config.json`), which maps each repo to its webhook secret env
   and release-notes path.
7. **What happens** — opening/editing a PR triggers the PR-reviewer GitHub Action
   (posts an AI review using the `MODEL_NAME` var, now deepseek-v4-pro per #47)
   and, on merge, the webhook invokes the Release Manager subagent to update
   `releasenotes.md`.

The existing `tests/readme-webhook.test.ts` (RED, 5 assertions) already covers
items 1–6. After the README is written, those 5 should pass → GREEN. No new test
needed unless we want to assert item 7's prose (optional).

## Out of scope

- Changing the `release-manager.config.json` contents.
- The model-config doc update (EVE_CHAT_MODEL / MODEL_NAME env vars) — that is a
  separate doc improvement; #41 is specifically the webhook flow. (Could be a
  follow-up README edit.)
- The `multi-repo-config` eval failure — separate issue.

---

## Tasks (TDD)

### Task 1 — RED (already exists; verify it still fails)

`tests/readme-webhook.test.ts` asserts the README contains the 6 webhook
markers. It currently fails (README lacks them).

**Step:** Run `node_modules/.bin/vitest run tests/readme-webhook.test.ts`.
Expected: 5 failed (README missing all markers). If already red, proceed.

### Task 2 — GREEN: write the README webhook section

**File:** `README.md` — insert the new section (after "Deployment", before
"Adding Tools" is fine). Content per Intended fix above. Keep existing sections.

**Step:** Run `node_modules/.bin/vitest run tests/readme-webhook.test.ts`.
Expected: 5 passed. Then full suite + `tsc --noEmit` clean (docs change doesn't
affect tsc, but confirm no accidental breakage).

### Task 3 — Verify code-review flow on the PR (the "test the code review" ask)

Open the PR for this branch. Confirm the PR-reviewer GitHub Action runs and
posts a **real** AI review (not "Fallback Mode"), now that:
- `OPENROUTER_API_KEY` has funded credit (user topped up), and
- `MODEL_NAME` defaults to `deepseek/deepseek-v4-pro` (#47/#48).
This validates the #41 change doubles as the code-review smoke test.

### Task 4 — Push for review (Phase 6 gate)

After TDD done and **authorized**, push and create PR referencing `Closes #41`.

---

## Files likely to change
- `README.md` (new webhook section)
- `tests/readme-webhook.test.ts` (existing RED test — reused, no change)
- `.hermes/plans/2026-08-30_readme-webhook-flow-41.md` (this plan)

## Validation
- `node_modules/.bin/vitest run tests/readme-webhook.test.ts` → 5 passed
- `node_modules/.bin/vitest run` → no NEW regressions
- `node_modules/.bin/tsc --noEmit` → clean
- PR posts a non-fallback AI code review

## Risks / open questions
- The README must use the **exact** substrings the test checks
  (`/api/github/webhook`, `GH_WEBHOOK_SECRET`, `GH_RELEASE_TOKEN`,
  "pull request", `release-manager.config.json`) or the test stays red.
- Webhook must still be **configured** in GitHub repo Settings for the flow to
  actually run — docs alone don't create it. The user previously confirmed no
  webhook existed; this PR documents how to add it but doesn't create it.
