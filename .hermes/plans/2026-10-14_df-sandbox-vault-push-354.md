# Plan — #354 Dark Factory E2E: vault-injected push token + provider key

- **Issue:** #354 (child of #352; carved out of #353, which is closed with the vault mechanism proven)
- **Branch:** `feat/df-sandbox-vault-push-354` (off `origin/main`)
- **Driver wiring:** R3 of epic #267 / #282 — `credentialProxy` + `networkPolicy` on OpenSandbox creation, gated by `DF_SANDBOX_VAULT_ENABLED`

## Goal

Make a real Dark Factory run prove the two secrets never land in a sandbox's `argv`, environment, or an authed-URL string:

1. **Push token** — injected into the sandbox via the OpenSandbox Credential Vault (the egress sidecar substitutes a placeholder with the real token). The sandbox's `git push` is driven by `GIT_ASKPASS` fed from the vault-injected credential.
2. **Provider key** — redeemed **server-side** by the gateway (already implemented in `app/api/llm-gateway/route.ts`); the sandbox only ever holds a per-run lease id, never the key.

Both are fail-closed on `DF_SANDBOX_VAULT_ENABLED` being unset.

## Verified premise (read the code, not the issue title)

- `grep` across `agent/lib/dark-factory` confirms `DF_SANDBOX_VAULT_ENABLED`, `credentialProxy`, `providerKey`, `pushToken` are **absent**. The gate and the R3 sandbox wiring are genuinely unwritten.
- `opensandbox-driver.ts` already imports `NetworkPolicy` and builds a deny-by-default egress policy (`sandboxNetworkPolicy`), but `createLiveSandbox` does **not** set `credentialProxy` and has no path to provision a credential into the sandbox vault.
- `app/api/llm-gateway/route.ts` already seeds `OPENROUTER_API_KEY` into an `InMemoryCredentialVault` and `forwardUpstream` redeems it via `resolveProviderKey` — **the provider-key half of #354 is done**. No change needed there beyond confirming the gateway host stays in the egress allow-list (it is, via `DF_SANDBOX_EGRESS_GATEWAY_HOST`).
- `git-push.ts` has `gitPushWithVault` (host-side, in-memory vault, temp `GIT_ASKPASS` file, authed URL never built) — used by `scripts/dark-factory-runner.ts` STEP 6. This is the **host-side fallback** that remains for the non-vault path.
- The OpenSandbox TS SDK exports `CredentialProxyConfig`, `CredentialProxy`, `CredentialBinding`, `NetworkPolicy`, and `sandbox.credentialVault` — the #353-proven substitution mechanism is available to the driver.
- `credential-vault.ts` defines two backends: `InMemoryCredentialVault` (supports server-side `redeem`, used by the **gateway**) and `OpenSandboxCredentialVault` (write-only from the host, `redeem` throws — used for secrets the **sandbox** needs, e.g. the push token). `opensandbox-credential-vault.ts` is already written and unit-tested against a fake.

**Conclusion:** the remaining work is concentrated on the **push token** path + the **gate**. The provider key is already vault-redeemed server-side.

## Intended fix

### Gate (fail-closed default)
- New env var `DF_SANDBOX_VAULT_ENABLED` (empty/blank = vault wiring OFF = today's behaviour). Added to `OpenSandboxDriverEnv` and `.env.example`.
- When **unset**, `createLiveSandbox` creates the sandbox exactly as today (no `credentialProxy`), and the runner pushes host-side via `gitPushWithVault` — **unchanged**.

### When the gate is set AND the driver is `opensandbox`
1. `createLiveSandbox` sets `credentialProxy: { enabled: true }` in the SDK create options.
2. Immediately after creation, the driver provisions the push token into the **sandbox's** `OpenSandboxCredentialVault` (`sandbox.credentialVault.put("git-push-token", token)`) plus a `CredentialBinding` whose substitution matches the git host and replaces a fixed **placeholder** (e.g. `__PUSH_TOKEN__`) in the outbound auth. The token is placed through the vault API only — never written into the sandbox's env/argv.
3. The OpenSandbox provider's `create()` returns the existing `WorkspaceTools` **plus** an optional `gitPush(owner, repo, branchName)` capability (present only when vault-enabled). It runs `git push` **inside the sandbox** via `sandbox.commands.run`, with `GIT_ASKPASS` set to a script written into the sandbox workspace that prints the **placeholder**; the egress sidecar substitutes the real token. `execSync` on the host is never used for the push on this path.
4. The runner's STEP 6 branches: vault-enabled + `gitPush` available → use it; otherwise → host-side `gitPushWithVault` (current behaviour).

### The one real design fork (confirm at GATE 1)
For the sandbox to `git push` and to be inspected, the **git repo must exist inside the sandbox**. Today the developer loop writes files into the sandbox workspace via `WorkspaceTools`, while `git add/commit/push` run on the **host** (`scripts/dark-factory-runner.ts` STEP 6). Two coherent options:

- **(A) Recommended — repo-in-sandbox.** When vault-enabled, the runner clones the target repo into the sandbox workspace (so it is a git working tree), the loop writes files there, and `git commit` + `git push` run **inside the sandbox** (commit moves in too, for one coherent flow). Host never commits or holds the token at push time.
- **(B) Push-only-in-sandbox.** Keep the host-side `git commit`; transfer the committed state into the sandbox before an in-sandbox `git push`. More moving parts, secret-surface unchanged.

Option A is the minimal coherent design and matches the AC ("process-tree inspection inside the sandbox"). The plan is written for A; if you prefer B, say so at GATE 1 and I will adjust the tasks.

### Fail-closed when misconfigured
If `DF_SANDBOX_VAULT_ENABLED` is set but the resolved `DF_SANDBOX_DRIVER` is **not** `opensandbox`, the driver refuses the run with a clear error (vault-backed wiring was requested but the execution backend cannot honor it). Recommended over a silent fallback — consistent with the repo's fail-closed posture. Confirm at GATE 1.

## Tasks (TDD — RED then GREEN, each paired commit)

- **T1 (gate + credentialProxy).** RED: `opensandbox-driver.test.ts` asserts `createLiveSandbox` sets `credentialProxy.enabled=true` when the gate is on, omits it when off, and refuses (throws) when the gate is on but no vault-capable provider. GREEN: implement the gate in `OpenSandboxDriverEnv` + `createLiveSandbox`.
- **T2 (token into sandbox vault + binding).** RED: a fake-SDK-vault test asserts `createOpenSandboxCredentialVault.put("git-push-token", token)` writes the credential + a `CredentialBinding` with the placeholder substitution, and `redeem` throws (write-only). GREEN: wire provider provisioning after sandbox create (binding shape taken from `credential-vault.md`).
- **T3 (in-sandbox git push).** RED: `git-push.test.ts` asserts the in-sandbox push command uses `GIT_ASKPASS` -> placeholder script, contains **no** secret in argv/env/authed URL, and the real token appears only as a vault-injected credential. GREEN: add `gitPush` to the OpenSandbox provider's `create()` return; implement the in-sandbox `git push` + placeholder askpass.
- **T4 (runner wiring + fail-closed).** RED: `dark-factory-runner` test (or a pure helper) asserts STEP 6 uses in-sandbox `gitPush` when vault-enabled, host-side `gitPushWithVault` otherwise, and refuses when the gate is set but the driver is not `opensandbox`. GREEN: branch STEP 6; pass the token to the provider only on the vault path; implement repo-in-sandbox clone/commit/push for option A.
- **T5 (env + docs + ADR).** Add `DF_SANDBOX_VAULT_ENABLED` to `.env.example`; recompute the `dark-factory-modules.md` module count; write ADR 0036 (see below); update `docs/pages/dark-factory-modules.md` if a new module file is introduced.

## Files likely to change

- `agent/lib/dark-factory/opensandbox-driver.ts` — gate, `credentialProxy`, token provisioning, `gitPush` capability.
- `agent/lib/dark-factory/git-push.ts` — in-sandbox push helper / placeholder askpass (host-side `gitPushWithVault` retained as fallback).
- `agent/lib/dark-factory/sandbox-provider.ts` — thread gate + fail-closed; (optionally) accept the push token source.
- `scripts/dark-factory-runner.ts` — STEP 6 branch; repo-in-sandbox clone/commit/push on the vault path.
- `tests/dark-factory/opensandbox-driver.test.ts`, `tests/dark-factory/git-push.test.ts` (+ runner helper test).
- `docs/adr/0036-*.md` (new), `docs/pages/dark-factory-modules.md`, `.env.example`.

## Validation

- `npx vitest run tests/dark-factory` — green (fakes for the SDK vault; no live cluster needed for CI).
- `npm run typecheck` — clean (`tsc --noEmit --incremental false`).
- `DF_PLATFORM_PROVIDER=generic npm run build` — green (compiles the driver + runner + gateway route).
- Local MegaLinter gates on changed files: cspell, markdownlint, markdown-table-formatter.
- **Real-run acceptance (the AC):** reproduced against the proven local K8s harness (`scripts/k8s-vault-proof/`), which stands up a vault-capable OpenSandbox control plane. A throwaway-branch run must (a) push via the vault-injected token, (b) make an LLM gateway call that uses the server-side-redeemed provider key, and (c) show, from inside the sandbox, no secret in `argv`/environment/authed-URL. This matches how #353's AC2 was proven; it is a manual repro, not a CI gate.

## Risks / open questions

- **Binding shape for git basic-auth.** #353 proved header substitution on an httpbin GET. A `git push` over HTTPS uses Basic auth via `GIT_ASKPASS`; the `CredentialBinding` substitution must target the auth credential/password field. Exact shape confirmed from `credential-vault.md` during T2 — if the SDK only substitutes into request *headers* (not the basic-auth password), the git path may need a `Authorization: Bearer` override instead of Basic, or a documented limitation. Flagged, not blocking.
- **Repo-in-sandbox** (option A) changes where `git commit` happens; the runner's current host-side `execSync` commit is removed on the vault path. Kept host-side for the non-vault path.
- **`DF_SANDBOX_EGRESS_GIT_HOST` must be `github.com`** for the git push egress to be allowed (the git host is only allowed when explicitly configured). Operator step, noted in the PR body.

## ADRs (identified at plan time)

- **ADR 0036 — push token is vault-injected into the sandbox via the OpenSandbox credential proxy; provider key stays server-side.** Decision: the sandbox egress sidecar is the only place the real push token exists at push time; the host seeds it through the write-only vault API and never sees it back. The provider key is redeemed in the gateway process, never in the sandbox. Rationale: satisfies #354's "no secret in argv/env/authed-URL" AC with the proven #353 mechanism. Consequences: a vault-capable OpenSandbox server is required for the vault path; the gate defaults off so non-vault deployments are unchanged.

## Decisions — CONFIRMED

- **Repo-in-sandbox — option A, CONFIRMED by the user at GATE 1.** When vault-enabled, the runner clones the target repo into the sandbox workspace; the developer loop writes into that clone; `git commit` and `git push` both run inside the sandbox. The host does not commit on the vault path and never holds the push token at push time. Option B (host-side commit, then an in-sandbox push) is rejected.
- **Fail-closed on a misconfigured gate — adopting the recommendation (my call; override on request).** `DF_SANDBOX_VAULT_ENABLED` set while `DF_SANDBOX_DRIVER` is not `opensandbox` refuses the run with an explicit error, rather than silently falling back to a host-side push.
- **`DF_SANDBOX_EGRESS_GIT_HOST=github.com` is a prerequisite** of the vault path (the git host is only egress-allowed when explicitly configured). Carried in the PR body as an operator step.
