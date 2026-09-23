# Configurable Platform-Neutral Dark Factory Adapters Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Isolate the Dark Factory runtime choices that currently depend on Vercel behind explicit, provider-neutral contracts and configuration, while preserving the existing secure Vercel path and a testable local/non-Vercel path.

**Architecture:** Keep orchestration and canonical payloads in `agent/lib/dark-factory/`; put deployment discovery, handoff transport, and runtime authentication decisions behind capability-specific adapters. Reuse existing `StateStore` and `WorkerProvider` seams rather than introducing a catch-all platform abstraction or a second storage system. Keep Next.js route files as hosting adapters at the edge, with platform-independent decision logic and tests beneath them.

**Tech Stack:** TypeScript, Node 24, Vitest, standard `Request`/`Response` interfaces at application boundaries, existing Next.js and Eve adapters.

---

## Issue and scope

- **Issue:** [#197 — Add configurable, platform-neutral Dark Factory adapters](https://github.com/ricardoblackskye/agent-eve/issues/197)
- **Parent:** #178, Dark Factory progress board.
- **This plan covers:** #197 only. It defines and configures the adapter boundaries that the run ledger/API/dashboard work can consume; it does not implement those later features.
- **Parent epic release placement:**

| Release          | Deliverables                                                      | Proposed branch                                          |
| ---------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| R6a — foundation | #197 platform adapters, then #198 durable run history and metrics | `feat/df-run-ledger` for the coordinated foundation work |
| R6b — board      | #199 read API and #200 progress board                             | `feat/df-progress-board`                                 |

Only #197 is planned in implementation detail here. Keep #198, #199, and #200 for their own approved plans/branches.

## Verified current context

- `agent/lib/dark-factory/state.ts` already defines a provider-neutral `StateStore`; `agent/lib/dark-factory/index.ts` owns its environment-based factory. Preserve and reuse this seam. No production shared-database adapter is part of #197; run-ledger persistence belongs to #198.
- `agent/lib/dark-factory/worker-env.ts` already defines `WorkerProvider` and a fail-closed provider factory. Its current `local` implementation is an honest dry run, not isolated execution.
- `agent/lib/dark-factory/entry.ts` contains two Vercel-specific reads: `VERCEL_ENV` in `resolveRunnerMode()` and `VERCEL_URL` in `resolveApiOrigin()`. The explicit `DF_API_BASE_URL` path and SSRF protection are already present and must remain intact.
- `resolveRunnerMode()` is exported and tested/demoed, but repository search found no production call site. The live entry path in `runDarkFactoryDispatch()` posts directly to the Eve session endpoint through `postHandoff()`; selection must be wired into that live path, not merely documented or tested in isolation.
- `agent/channels/eve.ts` directly adds `vercelOidc()` to the agent authentication chain alongside `localDev()` and bearer authentication.
- `app/api/github/webhook/route.ts` is a Next.js route adapter and uses `VERCEL_ENV` in the webhook-signature policy to distinguish Vercel preview from production and self-hosted production. The security policy must remain fail-closed in production while making deployment classification explicit and provider-neutral.
- `app/api/eve/v1/[...slug]/route.ts` uses `NextRequest`/`NextResponse` and forwards Vercel Protection bypass configuration. `proxy.ts` is also Next-specific, but the Google session primitives in `app/auth-*` are not Vercel-specific.
- Relevant existing tests include `tests/dark-factory/entry.test.ts`, `tests/webhook-secret-enforcement.test.ts`, `tests/webhook-handler.test.ts`, `tests/proxy-route.test.ts`, and the auth tests under `tests/`.

## Design decisions

1. Use small capability-specific seams; do not add a universal `PlatformAdapter` that mixes storage, auth, transport, and worker lifecycle.
2. Keep the Vercel SDK/environment reads inside Vercel adapters. The core consumes normalized deployment context, trusted origin, or an injected handoff/authenticator.
3. Make provider choice explicit through configuration. Unknown values and missing required configuration throw a named configuration error; no automatic downgrade to an insecure or ephemeral mode.
4. Retain a generic/local implementation that exercises the same contract without Vercel. Do not claim that it provides remote hosting or isolated worker execution.
5. Preserve existing security invariants: never trust a webhook `Host` value as the bearer-token destination; enforce webhook signatures for production; do not let a local-mode flag bypass a production check; keep Vercel Protection secrets server-side.
6. Do not replace Google OAuth, the Next.js application framework, or the existing storage provider in this issue. Their edge integration must remain separable, while larger product/runtime changes remain out of scope.

## Implementation tasks (TDD)

### Task 1: Add a normalized deployment-context contract and provider selector

**Objective:** Make environment classification a pure, testable capability instead of embedding Vercel environment checks in Dark Factory decisions.

**Files:**

- Create: `agent/lib/dark-factory/platform.ts` (canonical deployment context, provider interface, config validation, Vercel and generic/local adapters).
- Create: `tests/dark-factory/platform.test.ts`.
- Modify: `agent/lib/dark-factory/index.ts` to re-export the public factory/types if consistent with the existing single-import surface.
- Modify: `.env.example` for the documented provider selector and generic deployment settings after names are settled by the implementation.

**TDD steps:**

1. Declare the type/function signatures without behavior, then add tests for Vercel production/preview/development mapping, generic local/production mapping, unset provider behavior, unknown provider rejection, and malformed origin/config rejection.
2. Run `npx vitest run tests/dark-factory/platform.test.ts`; expected: tests execute and fail on the missing mapping/validation behavior, not at module collection.
3. Implement the smallest provider interface/factory and the Vercel and generic/local adapters. Read `VERCEL_ENV`/`VERCEL_URL` only in the Vercel adapter; read explicit provider-neutral settings in the generic adapter.
4. Re-run the focused test; expected: all provider mapping, fail-closed, and validation cases pass.

### Task 2: Route Dark Factory handoff and local/session selection through an adapter

**Objective:** Make configured provider selection control the real trigger-to-run handoff path.

**Files:**

- Create or modify: `agent/lib/dark-factory/handoff.ts` for the handoff interface, configured session adapter, and local dry-run/replay adapter.
- Modify: `agent/lib/dark-factory/entry.ts` to inject the selected handoff and normalized deployment context; remove direct `VERCEL_ENV`/`VERCEL_URL` decisions from core entry logic.
- Modify: `tests/dark-factory/entry.test.ts` and add focused `tests/dark-factory/handoff.test.ts` if the adapter tests are clearer separately.
- Modify: `scripts/dark-factory-local.ts` only as needed to demonstrate the same configured resolver, not as a separate implementation.

**TDD steps:**

1. Add tests proving each configured handoff is selected by the live `runDarkFactoryDispatch()` path, the local adapter performs no network write, an unsupported provider refuses, and a repeated trigger still uses the existing dedup guard.
2. Add regression cases for configured `DF_API_BASE_URL`, Vercel URL resolution, local loopback trust, hostile external `Host` refusal, and local-runner refusal in production for every deployment adapter.
3. Run `npx vitest run tests/dark-factory/entry.test.ts tests/dark-factory/handoff.test.ts`; expected: RED on adapter selection before implementation, then GREEN with the current SSRF/dedup behavior unchanged.
4. Implement the injected seam and wire it at the actual entry call site. Do not leave `resolveRunnerMode()` as an unused exported/demo-only selector.

### Task 3: Make the Vercel agent-auth option explicitly selectable

**Objective:** Keep Vercel OIDC available without requiring it as an unconditional auth integration on every host.

**Files:**

- Modify: `agent/channels/eve.ts` to select the configured auth integration while retaining `localDev()` only in its existing non-production role and retaining bearer validation/fail-closed behavior.
- Create or modify: focused channel-auth tests (likely `tests/agent-channel-auth.test.ts`; verify Eve channel APIs and test conventions before choosing the final path).
- Modify: `.env.example` and `README.md` with supported auth-provider values and required settings.

**TDD steps:**

1. Add tests for explicit Vercel OIDC selection, generic bearer selection, local development behavior, missing/unknown provider behavior, and rejection of missing or invalid bearer credentials when bearer auth is selected.
2. Run the focused channel-auth test; expected: failure on provider selection before wiring the factory.
3. Add a narrow factory for the configured authenticator list. Keep credentials out of provider IDs, logs, and error messages.
4. Re-run the focused test; expected: selected provider is active and all invalid-auth cases remain denied.

### Task 4: Keep webhook policy and HTTP hosting portable at the route boundary

**Objective:** Remove Vercel environment detection from webhook policy while retaining the current preview, local, and production security behavior.

**Files:**

- Modify: `app/api/github/webhook/route.ts` so `requiresSignature`/signature policy consumes normalized deployment context, not raw `VERCEL_ENV`.
- Modify: `tests/webhook-secret-enforcement.test.ts` and `tests/webhook-handler.test.ts` for Vercel production, explicit preview, local development, and self-hosted production.
- Review: `app/api/eve/v1/[...slug]/route.ts`, `proxy.ts`, and `tests/proxy-route.test.ts`. Keep Next request/response types and Vercel Protection header injection in the host adapter; avoid importing these from `agent/lib/dark-factory` or changing Google session policy. Only change bypass forwarding if a provider adapter can preserve the existing trusted server-side behavior and tests.

**TDD steps:**

1. Add/adjust policy tests so self-hosted production with no secret is refused, Vercel production is refused, explicit preview/local behavior remains intentional, and a configured secret is still verified in every deployment mode.
2. Run `npx vitest run tests/webhook-secret-enforcement.test.ts tests/webhook-handler.test.ts tests/proxy-route.test.ts`; expected: the policy tests fail if deployment classification is not injected.
3. Adapt the Next route to supply the normalized context and keep HTTP request/response mapping at the edge.
4. Re-run focused tests; expected: all prior signature and proxy behaviors remain covered and green.

### Task 5: Document provider configuration and prove no Vercel coupling in core

**Objective:** Make the swap operationally understandable and guard the boundary against regressions.

**Files:**

- Modify: `.env.example`, `README.md`, and `ARCHITECTURE.md` with provider names, required configuration, fail-closed behavior, current adapter support, and the distinction between dry-run and isolated execution.
- Add/modify tests under `tests/dark-factory/` for unknown/missing configuration and for the core import boundary. Prefer behavior-level/provider-contract checks over a broad source regex.

**TDD/verification steps:**

1. Add a contract test that instantiates the configured Vercel and generic/local adapters with the same canonical inputs and asserts equivalent core outcomes; ensure the dry-run adapter reports no external write and no isolation.
2. Run all focused tests above, then `npm test`; expected: no regressions.
3. Run `npm run typecheck` and `npm run build`; expected: clean typecheck and successful Next build for the retained host adapter.
4. Run the repository cspell and Markdown checks on every changed file, including this plan; fix findings before push.
5. Review `git diff --check`, inspect imports in `agent/lib/dark-factory/`, and confirm Vercel-specific identifiers occur only at adapter/host boundaries.

## Likely files to change

- `agent/lib/dark-factory/platform.ts` (new) and possibly `handoff.ts` (new)
- `agent/lib/dark-factory/entry.ts`, `agent/lib/dark-factory/index.ts`
- `agent/channels/eve.ts`
- `app/api/github/webhook/route.ts`
- Possibly `app/api/eve/v1/[...slug]/route.ts` only for a contained host-adapter extraction
- `.env.example`, `README.md`, `ARCHITECTURE.md`
- `tests/dark-factory/platform.test.ts` (new), `tests/dark-factory/handoff.test.ts` (new if needed), `tests/dark-factory/entry.test.ts`, channel auth tests, `tests/webhook-secret-enforcement.test.ts`, `tests/webhook-handler.test.ts`, `tests/proxy-route.test.ts`

## Validation commands

```bash
npx vitest run tests/dark-factory/platform.test.ts tests/dark-factory/entry.test.ts tests/dark-factory/handoff.test.ts
npx vitest run tests/webhook-secret-enforcement.test.ts tests/webhook-handler.test.ts tests/proxy-route.test.ts
npm test
npm run typecheck
npm run build
```

Run only the test paths that exist after implementation; if a new focused test file is not needed, omit it from the command. Also run the repository's local spell/style checks against all changed files before pushing.

## Risks and open questions

- **Vercel Preview signature policy:** current code permits unsigned preview requests when no secret exists, while production and self-hosted production fail closed. Keep this exception explicit in the normalized deployment policy; do not silently treat an unknown deployment as preview/local.
- **Unused selector:** `resolveRunnerMode()` currently has no production caller. Adding another config parser without wiring it into `runDarkFactoryDispatch()` would satisfy unit tests but not the issue.
- **Scope control:** Next.js is the current web framework, not itself a Vercel-only platform service. This issue isolates Vercel-specific behavior at Next/Vercel edges; it does not replace the application framework or implement a new cloud deployment target.
- **Existing storage and worker seams:** #197 should reuse them, not duplicate them. It does not add the durable run-ledger store (#198), a production queue, a hosted sandbox, or a new database vendor.
- **Configuration safety:** provider selection and deployment context must not be derived from untrusted request headers. A local selection must never bypass a production signature/auth gate.
- **Auth boundary:** Vercel OIDC for service-to-service Eve access and Google session auth for dashboard viewers are different concerns. Do not conflate them or broaden public routes.
- No new external credentials are required for the local/non-Vercel contract tests. Live platform adapters remain opt-in and require their own deployment configuration.
