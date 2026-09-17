# Issue #78 — Webhook signature enforcement fails open on non-Vercel deployments

**Branch:** `fix/webhook-signature-fail-closed-78` (off `origin/main` = `40305b7`)
**Issue:** #78 · labels: `enhancement` (a latent security hole, not an incident)
**Type:** bug fix → `systematic-debugging` + `test-driven-development`

## Goal

Make webhook signature enforcement **deny by default** on any real deployment,
so a self-hosted operator who forgets `GH_WEBHOOK_SECRET` gets a loud refusal
instead of silently accepting forgeable payloads — without re-breaking the
Vercel preview eval suite.

## Root cause (verified in the code, not assumed)

`app/api/github/webhook/route.ts`:

```ts
function isProductionEnvironment(): boolean {      // line 50
  return process.env.VERCEL_ENV === "production";
}

function verifySignature(payload, signatureHeader, secret): boolean {
  if (!secret) {
    if (isProductionEnvironment()) return false;   // line 68
    return true;                                   // line 71  ← ACCEPTS
  }
  ...
}
```

```ts
const webhookSecret = process.env[repoConfig.webhook_secret_env];
if (!webhookSecret && isProductionEnvironment()) { // line 141
  ...return 500 "Refusing to process an unverified webhook";
}
```

The gate is keyed on a **platform-owned** variable. `VERCEL_ENV` is set only by
Vercel, so on any other deployment it is `undefined` → `isProductionEnvironment()`
is `false` → **both** guards take the permissive branch:

1. line 141's 500-refusal is skipped, and
2. `verifySignature()` returns `true` for a missing secret (line 71).

Net effect: a self-hosted deployment (`npm run build && npm start`, documented in
`README.md` § Self-Hosted / Docker, where `NODE_ENV=production` but `VERCEL_ENV`
is unset) accepts **unsigned, forgeable webhook payloads** and says nothing.

This is the fail-open shape: *"we could not tell, so we assumed development."* The
absence of configuration is read as a reason to relax the control — the same
anti-pattern fixed for `STORY_ALLOWED_REPOS` in #119.

**Not currently exploited:** Vercel production does have `GH_WEBHOOK_SECRET` set,
so it enforces correctly today.

## The constraint that made this "deferred" (verified)

PR #77's review raised it; commit **`23dbd46`** reverted an earlier attempt:

> "The webhook secret check failed closed on `VERCEL_ENV=preview`, but preview has
> no secret configured and the preview eval suite posts unsigned webhooks at it,
> breaking `multi-repo-config` and `webhook` evals. Narrowed to production only."

So a naive `NODE_ENV === "production"` check was believed unsafe (Vercel previews
run a production build, so `NODE_ENV` is `production` there too).

**That constraint has since weakened**, and the issue's checklist asks to verify
it. Evidence:

| Fact | Where |
| --- | --- |
| `.github/workflows/preview-evals.yml` provides `EVE_EVAL_AUTH_TOKEN` and `VERCEL_PROTECTION_BYPASS` — **no `GH_WEBHOOK_SECRET`** | workflow lines 37–38 |
| The evals gate signing on `canSign()` = `Boolean(process.env.GH_WEBHOOK_SECRET)` | `evals/helpers/sign.ts` |
| With no secret available they **skip the happy path** (`t.succeeded(); return;`) rather than assert unsigned behaviour | `evals/webhook.eval.ts:60-63` |

That skip-when-the-prerequisite-is-absent pattern is exactly what #119 adopted, so
failing closed on preview should now be *safe*. **But I cannot prove it from this
host:** the preview evals only run on a Vercel deployment, and local `eve eval`
does not run on this machine's Node 22 (the Eve runtime needs Node 24). So preview
behaviour is only verifiable in CI.

## Design decision (a deliberate deviation from the issue's suggestion)

The issue proposes an explicit opt-in:

```ts
const requireSignature =
  process.env.REQUIRE_WEBHOOK_SIGNATURE === "true" ||
  process.env.VERCEL_ENV === "production";
```

That closes the hole **only for an operator who already knows about it** — a
self-hoster who changes nothing still fails open, which is the actual defect. So
the plan inverts the default instead, while keeping preview green:

```ts
function requiresSignature(): boolean {
  if (isTruthy(process.env.REQUIRE_WEBHOOK_SIGNATURE)) return true;   // explicit opt-in, any env
  if (isTruthy(process.env.ALLOW_UNSIGNED_WEBHOOKS)) return false;    // explicit, deliberate opt-out
  if (process.env.VERCEL_ENV === "production") return true;           // Vercel production
  // Any OTHER production build (self-hosted/Docker): NODE_ENV=production
  // with no Vercel preview marker → deny by default.
  return process.env.NODE_ENV === "production" && process.env.VERCEL_ENV !== "preview";
}
```

Truth table:

| Environment | `requiresSignature()` | Behaviour with no secret |
| --- | --- | --- |
| Local dev (`NODE_ENV=development`) | false | permissive (unchanged) |
| Vercel preview (`VERCEL_ENV=preview`) | false | permissive (**evals preserved**) |
| Vercel production | true | 500 refusal |
| **Self-hosted (`NODE_ENV=production`, no `VERCEL_ENV`)** | **true** | **500 refusal (the fix)** |
| Any env with `REQUIRE_WEBHOOK_SIGNATURE=true` | true | 500 refusal (opt-in for preview/dev hardening) |
| Anything with `ALLOW_UNSIGNED_WEBHOOKS=true` | false | permissive (explicit, documented as dangerous) |

Note the existing behaviour this **preserves**: whenever a secret *is* configured,
the HMAC is verified regardless (line 158) — that path is untouched.

Also from the issue's checklist, and in scope:
- **Log once when the permissive path is taken**, so a misconfigured deployment is
  visible instead of silent.
- **Document** the variable and the requirement in `.env.example` and the README
  Self-Hosted / Docker section.

## Tasks (TDD, vertical tracer bullets)

| # | RED (failing test first) | GREEN | AC |
| --- | --- | --- | --- |
| 1 | self-hosted (`NODE_ENV=production`, no `VERCEL_ENV`) + no secret ⇒ **500**, not 200 | `requiresSignature()` + use at the 500 guard | the bug |
| 2 | the same deployment with a signature header but no secret ⇒ still refused, never 200 | `verifySignature` consults `requiresSignature()` | the bug |
| 3 | Vercel **preview** + no secret ⇒ still permissive (the eval-preserving case) | ordered checks | no regression |
| 4 | local dev + no secret ⇒ still permissive | `NODE_ENV=development` branch | no regression |
| 5 | `REQUIRE_WEBHOOK_SIGNATURE=true` in preview/dev ⇒ refused | opt-in branch | defence in depth |
| 6 | `ALLOW_UNSIGNED_WEBHOOKS=true` ⇒ permissive even on a production build | opt-out branch, documented as dangerous | operator escape hatch |
| 7 | a configured secret still verifies the HMAC (valid ⇒ 200, invalid ⇒ 401) on every environment | untouched path, locked by test | no regression |
| 8 | the permissive path logs a one-time warning naming the env | `console.warn` once, asserted via spy | visibility |
| 9 | doc guard: `.env.example` documents both new vars | `.env.example` + `tests/dark-factory/env-docs.test.ts`-style guard | docs |

## Files likely to change

- `app/api/github/webhook/route.ts` — `requiresSignature()`, the two call sites, the one-time warning.
- `tests/webhook-secret-enforcement.test.ts` — the new cases (existing suite keeps its production assertions).
- `.env.example` — `REQUIRE_WEBHOOK_SIGNATURE`, `ALLOW_UNSIGNED_WEBHOOKS` (config, not secrets).
- `README.md` — Self-Hosted / Docker: the secret is required, plus the new vars.
- `.cspell.json` — any new vocabulary.

## Validation

- `npx tsc --noEmit` clean; full `npx vitest run` with no regressions.
- Local lint gate before push: cspell + prettier on changed files only (incl. this plan).
- The 8 behavioural cases above, each watched fail before passing.
- **Explicitly NOT verifiable here:** the Vercel preview evals. Called out below.

## Risks / open questions

- **Preview evals are only verifiable in CI.** My design keeps `VERCEL_ENV=preview`
  permissive, so the change should be transparent to them — but the honest statement
  is "designed not to affect preview; confirm on the CI run". If a preview eval does
  fail, the fallback is to gate the self-hosted branch behind
  `ALLOW_UNSIGNED_WEBHOOKS` semantics inverted (opt-in), which is the issue's
  original proposal.
- **A self-hoster who has no secret will now get 500s** where they previously got
  200s. That is the intended fail-closed behaviour and is visible (warning log +
  explicit error message), but it *is* a behaviour change for that (broken) setup.
  Documented in the README.
- **`NODE_ENV` is set by the framework, not the operator**, so this leans on Next.js
  setting `NODE_ENV=production` for `next build`/`next start`. Verified by test
  against the route, not by assumption; the explicit opt-in covers anyone whose
  runtime differs.

## Status

**GATE 1 — awaiting plan approval.** No implementation code until you approve.
