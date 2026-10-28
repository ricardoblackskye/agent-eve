# Plan: upgrade `eve` 0.44.4 → 0.64.0 (#509)

## Goal
Upgrade the pinned `eve` dependency so the session-create `Hook not found` (`HookNotFoundError`) failure clears.
Today it makes `Vercel Preview Evals` red on PRs **and** reproduces in **Production** — so production session
creation is intermittently broken, not just CI.

## Why 0.64.0, not `latest`
eve's own changelog names this exact error as fixed:
- `56e3510` — "fix(eve): preserve session ownership across handoffs" (`vercel/eve` PR #3607)
- `dea2ced` — "fix(eve): quiet expected workflow contention warnings" (PR #3608)

Both are in the **0.63.1** changeset, which npm never published (0.63.0 = 2026‑09‑19, next published release
**0.64.0** = 2026‑09‑22, same day the fix commits landed). So **>=0.64.0** is the floor.

0.64.0 also sits **below** every explicit breaking change that could plausibly hit this repo:

| Flagged break                                                                                            | This repo uses it?                                                                 |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 0.66.0 `ctx.getSkill()` / `SkillHandle` / `SkillFile` removed                                            | No — zero hits                                                                     |
| 0.72.0 `evaluate`→`decide` (`eve/ai`), `ai@7.0.128`                                                      | No — no `eve/ai` import                                                            |
| 0.82.0 `limits.max*PerSession` → `limits.sessionUsage`                                                   | No — zero hits                                                                     |
| 0.83.0 `defineSandboxProvider()` byte-level `SandboxConnection`                                          | No — zero hits (we use our own driver seam)                                        |
| 0.84.1 dynamic models need `modelContextWindowTokens`                                                    | Already satisfied (`governed-model.ts:57`)                                         |
| 0.85.0 redirects rejected; cross-project callbacks need Trusted Sources + `EVE_CALLBACK_TRUSTED_ORIGINS` | **AT RISK** — we have `resolveApiOrigin` + `DF_API_BASE_URL` + the proxy + webhook |

Targeting 0.64.0 avoids the 0.85.0 handoff-surface risk for no loss. Going to `latest` is a *separate* follow-up.

## Scope
- Bump `eve` to `0.64.0`; regenerate the lockfile. **Dependency-only diff.**
- Fix any fallout the gates surface (expected: none to small; `tsc` is the first net).
- Out of scope: `latest`/0.85.0, the Rust sandbox EPIC (#507), any behavioural change to the Dark Factory.

## Steps
1. Branch `chore/upgrade-eve-64` off `origin/main` (created before any code; this plan rides in the first push).
2. **Capture a baseline first** — record the green counts and timings on `main` so any delta is visible.
3. `npm i eve@0.64.0` (exact, not `^`), regenerate `package-lock.json`.
4. Run T0 → T6 below. Fix fallout at T0/T1 first (compile errors are the cheapest signal).
5. Push, open the PR, and let the CI jobs + **Preview Evals** be the acceptance gate.
6. Canary: merge, then watch **Production Evals** (production is currently failing, so it is both the canary and
   the thing being fixed).

---

# The test matrix

Every tier below is a real command from this repo (`package.json` / `.github/workflows/ci.yml`), not an invented
one. Baseline to beat: **312 files / ~2957 passed / 50 skipped / 0 failed** (unit), `tsc` clean, cspell clean.

## T0 — Static + build gates (fastest net for API removals and signature changes)
| Command                                                   | Mirrors CI                          | Catches                                                                                   |
| --------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `npm run typecheck` (`tsc --noEmit`)                      | job **TypeScript**                  | removed/renamed APIs, changed signatures, `defineAgent`/`defineDynamic` union brittleness |
| `npm run build` (`next build`)                            | job **Eve Build**                   | route/build integration with the new framework                                            |
| `npm run eve:build` (`eve build`)                         | (extra)                             | the framework's own bundle/compile — most directly exercises an eve upgrade               |
| `npx cspell --no-progress <changed files>` + markdownlint | job **MegaLinter** is authoritative | spelling/markdown drift                                                                   |

## T1 — Unit / contract / integration (vitest)
Prerequisite: local Postgres (the vitest `globalSetup` is `tests/dark-factory/pg-global-setup.ts`, which resets
shared tables — without it those files skip and the comparison is meaningless):
```
docker run -d --name df-local-pg -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=darkfactory postgres:16-alpine
```
| Command                    | Mirrors CI                | Catches                                                                                                       |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm run test:coverage`    | job **Unit Tests** step 1 | behaviour drift in `agent/**`, `app/**` — the governed model resolver, cost gate, proxy/auth, every DF module |
| `npm run coverage:ratchet` | job **Unit Tests** step 2 | coverage regression introduced while porting                                                                  |

Watch the **skip count** as closely as the pass count: a new skip is a test that stopped exercising the path.

## T2 — Local runtime proof (boots, not just compiles)
```
npm run build && npm start            # or: npm run dev
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/eve/v1/health        # expect 200
```
Then exercise the auth surface with a **bad** token (expect >= 400) and re-check the port is freed afterwards.
Catches: runtime dependency/engine refusals and the bare fact that the app can serve after the bump.

## T3 — Evals, local (the primary breaking-change net for the agent surface)
Mirror the CI **Eve Evals** job exactly:
```
mkdir -p .eve
EVE_API_KEY=test-eval-key EVE_EVAL_AUTH_TOKEN=test-eval-key \
  npm run dev -- --hostname 127.0.0.1 --port 3000 > .eve/next-dev.log 2>&1 &
# wait: until curl --fail http://127.0.0.1:3000/eve/v1/health succeeds (CI allows 60s), and surface the log if it dies
npx eve eval --strict --exclude-tag production --junit .eve/junit.xml --url http://127.0.0.1:3000
```
All 9 evals matter here, and each covers a distinct contract:
`smoke` + `auth-valid` (session creation — **the defect's own path**), `auth-invalid` (auth enforced),
`model-check` (**`/eve/v1/info` shape** — the governed/static model contract), `frontend` (proxy + status page),
`webhook`, `multi-repo-config`, `release-notes-tool`, `product-owner`.
`--strict` matters: it fails the exit code when any score drops below threshold, so a green job means no gate fell short.

## T4 — Playwright E2E, local (full browser journeys + a real model call through the proxy)
Mirror the CI **Playwright E2E** job (seed fixture, then run):
```
mkdir -p .eve
# seed step (sqlite only; no real database is touched)
DF_TENANT_DRIVER=sqlite DF_TENANT_DB_PATH=.eve/e2e-tenant.sqlite \
DF_USAGE_DRIVER=sqlite DF_USAGE_DB_PATH=.eve/e2e-usage.sqlite \
DF_COST_BUDGET_DRIVER=sqlite DF_COST_BUDGET_DB_PATH=.eve/e2e-cost.sqlite \
DF_RUN_HISTORY_DRIVER=sqlite DF_RUN_HISTORY_DB_PATH=.eve/e2e-runs.sqlite \
DF_CONTROL_DRIVER=sqlite DF_CONTROL_DB_PATH=.eve/e2e-control.sqlite \
DF_MEMBERSHIP_DRIVER=sqlite DF_MEMBERSHIP_DATABASE_PATH=.eve/e2e-membership.sqlite \
DF_AMM_SCAN_DRIVER=sqlite DF_AMM_SCAN_DB_PATH=.eve/e2e-amm.sqlite \
npm run seed:test-data -- --all
DF_MEMBERSHIP_DRIVER=sqlite DF_MEMBERSHIP_DATABASE_PATH=.eve/e2e-membership.sqlite \
  npm run df:membership -- grant --email cuillinguy@gmail.com --role operator
npx playwright install --with-deps chromium
# run step — same sqlite drivers, but DELIBERATELY WITHOUT DF_COST_BUDGET_DRIVER
AUTH_DEV_MODE=1 DF_WORKER_ALLOWED_REPOS=ricardoblackskye/agent-eve,seed-org/amm-ready \
DF_TENANT_DRIVER=sqlite DF_TENANT_DB_PATH=.eve/e2e-tenant.sqlite \
DF_USAGE_DRIVER=sqlite DF_USAGE_DB_PATH=.eve/e2e-usage.sqlite \
DF_RUN_HISTORY_DRIVER=sqlite DF_RUN_HISTORY_DB_PATH=.eve/e2e-runs.sqlite \
DF_MEMBERSHIP_DRIVER=sqlite DF_MEMBERSHIP_DATABASE_PATH=.eve/e2e-membership.sqlite \
DF_AMM_SCAN_DRIVER=sqlite DF_AMM_SCAN_DB_PATH=.eve/e2e-amm.sqlite \
npm run test:e2e
```
Three load-bearing caveats, straight from `ci.yml`:
- **Never set `DF_COST_BUDGET_DRIVER` for e2e** — configuring the budget store arms the orchestrator's cost gate,
  which then refuses every model call with `not_configured` until a global cap is provisioned (ADR 0015). That
  broke the chat specs before; it is a fixture rule, not an incidental one.
- The chat specs make a **real call through the proxy**, so `OPENROUTER_API_KEY` must reach the server (CI passes
  it as a secret; locally the dev server reads `.env.local` — confirm which, do not assume).
- `playwright.config.ts` starts its own `npm run dev` webServer (reuse outside CI), so kill any server already on
  :3000 first.

## T5 — E2E against a DEPLOYED target (the only tier that can validate the fix)
| Target                | Command / job                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| PR preview            | **Preview Evals** job: `npx eve eval --strict --junit .eve/junit-preview.xml --url "$TARGET_URL"` |
| PR preview (browsers) | `BASE_URL=https://<preview-url> npm run test:e2e` (`playwright.config.ts` reads `BASE_URL`)       |
| Production            | **Production Evals** job after merge (main-only)                                                  |

**Honest limit: T0–T4 cannot reproduce this defect.** In dev the workflow world is `local`
(`WORKFLOW_TARGET_WORLD` unset + no `VERCEL_DEPLOYMENT_ID`) and there are no deployments, so the
deployment-**handoff** condition does not exist locally. Local tiers capture *breaking-change* risk; **only T5
validates the session-create fix.** The plan must not claim otherwise.

## T6 — Dark Factory + sandbox (our own use of the durable/session layer)
| Command                                                                                          | Catches                                                                                     |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `df:local-run` (with `DF_RUN_HISTORY_DRIVER=postgres`) → plan posted, park, and a `df_plans` row | our end-to-end use of eve's session/durable path, incl. the #508 persistence                |
| `df:retire-claim` after the proof run                                                            | cleans the ledger so later runs are not refused                                             |
| `df:sandbox-up` + `df:sandbox-smoke`                                                             | our sandbox driver seam survives (eve 0.83 changed *its* provider API, which we do not use) |
| `npm run models:verify`, `npm run prices:check` (optional, network)                              | external model/price catalogue drift                                                        |

---

# Risk → test mapping

| Risk                                                                  | Where it is caught                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------- |
| API removals / signature changes (0.66, 0.72, 0.82, 0.83, 0.85 Slack) | T0 `tsc`                                                       |
| `defineAgent`/`defineDynamic` union brittleness                       | T0 `tsc` / `eve build`                                         |
| Governed dynamic model + context window (0.84.1)                      | T0 build + T3 `model-check`                                    |
| 0.85.0 redirects / cross-project Trusted Sources                      | T5 preview + prod evals; T4 browser journeys through the proxy |
| Unlabelled behaviour drift across 0.45.0→0.63.x (the real unknown)    | T1 unit suite, T3 evals, T4 e2e, T6 DF run                     |
| The session-create / hook-ownership defect itself                     | T3 locally (smoke/auth-valid), **T5 on a deployment**          |

# GATE 1 decisions
1. **Target 0.64.0** (recommended) or go straight to 0.85.0 and take the handoff-surface risk?
2. Local e2e needs a real `OPENROUTER_API_KEY` for the chat specs — ok, or shall I run e2e only in CI and keep
   local to T0–T3 + T6?
3. If 0.64.0 does **not** clear the session-create failure, stop and re-plan (the causation would be wrong) —
   agree?

# Rollback
Dependency-only diff on a dedicated branch → revert is a single commit. Preview canary before merge.
