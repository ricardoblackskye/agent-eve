# Plan — #318: the Slack notification adapter (incoming webhook)

**Branch:** `feat/df-slack-adapter-318` (off `origin/main` @ `6155ee7` — the #317 merge)
**Issue:** [#318](https://github.com/ricardoblackskye/agent-eve/issues/318) — split **b** of 2 from #274
**Epic:** #267 · **Date:** 2026-10-11

## Goal

The **first real adapter** for the notification seam: Slack, via an **incoming webhook URL** — no
vendor SDK, no OAuth, no app registration. The seam itself shipped in #317; this is the driver.

## Shape to mirror (do not invent)

`pr-writer.ts`: an **injected `fetchImpl`** for offline/deterministic tests, an options object
(`{ fetchImpl?, env? }`), results as `{ ok, status?, error? }` rather than throws, and a `configured`
getter. The same shape applies here.

## Why #318 needs NO new wiring

**#317's** `withNotifications(store, env)` already wraps the store on both write paths and already
consults `createNotificationProvider(env)`. So adding a `slack` driver makes the channel live
end-to-end — `DF_NOTIFY_DRIVER=slack` + the webhook URL is the whole activation. There is no second
composition point to forget, which is the point of the decorator.

## Avoiding an import cycle (a real constraint)

The adapter needs the canonical `Notification` type; the factory in `notifications.ts` needs the
adapter's class. So the adapter imports **types only** (`import type`) — erased at runtime, one
direction left — and `notifications.ts` imports the class. No cycle, and no change to #317's public
API in the process.

## Acceptance criteria, as I will implement them

- [ ] Selected by configuration: `DF_NOTIFY_DRIVER=slack` + `DF_SLACK_WEBHOOK_URL`. Unset => the
      seam's no-op default (asserted: the adapter is never constructed by accident).
- [ ] The webhook URL is a **secret**: never logged, never placed in the request body, never written
      to the ledger. A test asserts it does **not** appear in the sent body *or* in any error string.
- [ ] An **absent or malformed URL is a configuration error that THROWS** (the fail-closed env
      convention), not a silent no-op an operator could mistake for "working".
- [ ] **Best-effort**: a non-2xx response, a network error or a timeout returns `{ ok: false }` and
      is logged by the seam — a notification can never fail a run.
- [ ] **Bounded**: an explicit timeout per attempt, and **at most one retry** (two attempts total) —
      no retry storm. Asserted by counting attempts against a persistently failing endpoint.
- [ ] The rendered message is built from the **canonical notification only**: no extra data, no free
      text, no secret. A test pins that.

### One honest clarification of the AC written in #318

**#318's** wording says the adapter "adds **no** new fields". Slack's incoming webhook requires a
`{ "text": ... }` envelope, so the adapter necessarily **renders** the canonical payload into that
wire shape. I will satisfy the *intent* — the message contains **no data beyond the canonical
payload** and no secret — and say so plainly rather than pretending the body is byte-identical to
the canonical object. A pure `renderSlackMessage(notification)` does the rendering, so it is
unit-testable without a network.

## Tasks (TDD, RED -> GREEN per task)

- **T1** — `renderSlackMessage`: kind + repo#issue + run id + status/stage (+ reasonCode / prUrl when
  present), and nothing else.
- **T2** — the adapter: posts the rendered body; a non-2xx is a handled failure; a timeout is a
  handled failure; the URL never leaks into the body or the error.
- **T3** — configuration: a missing/malformed URL throws; the factory selects `slack` **only** when
  the driver is set, and still returns the no-op default otherwise.
- **T4** — `.env.example`: document `DF_SLACK_WEBHOOK_URL` (SECRET) and update the driver comment
  (the **env-example-coverage** guard requires every referenced variable to be documented — it caught
  exactly this in #317).

## Files likely to change

- `agent/lib/dark-factory/slack-notification.ts` (**new**) — the adapter + renderer + its
  configuration error.
- `agent/lib/dark-factory/notifications.ts` — the `slack` branch of the driver factory, and the
  supported-driver list.
- `.env.example` — the new variable.
- `docs/pages/dark-factory-modules.md` — one new catalog row, count recomputed
  (`ls -1 agent/lib/dark-factory/*.ts | wc -l`; currently 80).
- Tests.

## Validation

- `npx vitest run` (full suite), `npx tsc --noEmit --incremental false`,
  `DF_PLATFORM_PROVIDER=generic npm run build`
- cspell over **every** changed file (`git diff --name-only origin/main...HEAD`, **after** committing)
- doc-drift + ADR-integrity + **env-example-coverage** guards
- **Non-vacuity**: remove the `slack` branch from the factory and prove a test fails
- Rebase onto the then-current `origin/main` **and push the rebase**

## Explicitly out of scope

- Email (Resend/SMTP) — its own decision if wanted. Inbound Slack. A preferences UI.
- Changing the seam, the payload, or the decorator from #317 — this is a driver only.

## Open question for you

None blocking. One thing I will assume unless you say otherwise: **at most one retry**, applied to a
retryable failure (network error, timeout, or 5xx) and **not** to a 4xx — a malformed request is a
configuration problem, so retrying it would just double the noise.
