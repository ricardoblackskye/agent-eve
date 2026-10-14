# Plan — #282 R3: Sandbox credential-vault egress (secret-free provider key + push token)

> Parent epic: #279 (Alibaba/OpenSandbox integration). Builds on **R2 (#281)**, which is in PR #347
> (awaiting merge). This plan is for T5b's successor release and closes the four acceptance criteria
> left by R2 around where secrets live.

- **Author:** Senior Software Engineer
- **Date:** 2026-10-13
- **Branch:** `feat/df-sandbox-credential-vault-282` (issue #282 suggests `-279`; using `-282` to match the
  per-issue branch convention established by R2's `feat/df-author-wiring-281`. Rename if you prefer.)
- **Status:** DRAFT — pending GATE 1.

---

## 1. Goal

Make the sandbox **secret-free**. Today two raw secrets are visible in process arguments / shell strings:

1. **Git push token** — `scripts/dark-factory-runner.ts:533`
   `const pushUrl = \`x-access-token:${token}@github.com/...\`` then
   `execSync(\`git push ${pushUrl} ${branchName}\`, ...)`. The token sits in a shell string + argv.
2. **Model-provider key** — `app/api/llm-gateway/route.ts:50`
   `authorization: *** ${env.OPENROUTER_API_KEY ?? ""}` inside `forwardUpstream`, which **already closes
   over it server-side** (R2's design: the CLI inside the sandbox holds only a lease and calls our
   gateway, never the provider directly). So the provider key is already server-side; R3 moves it behind
   a write-only credential vault + lease so it is also never in env / argv / logs / metrics / errors.

R3 changes **only where secrets live** — it does not alter authoring or gateway behaviour (R2's scope).

## 2. Recon findings (real, not assumed)

- **SDK (`@alibaba-group/opensandbox`) exposes the Credential Vault API:**
  - `CredentialVault`, `CredentialVaultCreateRequest { bindings: CredentialBinding[] }`,
    `CredentialVaultMutationRequest { bindings: CredentialBindingMutationSet (add/replace) }`,
    `CredentialProxyConfig` (transparent MITM proxy for injection — explicit opt-in),
    `CredentialBinding { match: CredentialMatch, substitutions: CredentialSubstitution[] }`,
    `CredentialSubstitution { in: "path"|"query"|"header"|"body" }`, `CredentialMatch { schemes, host, path }`.
  - Methods: `Sandboxes` / `SandboxManager` expose `createCredentialVault(req)`,
    `listBindings()`, `getBinding(name)`, plus mutation/patch. Write-only values are never returned
    (sanitized `CredentialVaultState` / `CredentialListResponse`).
  - `CreateSandboxRequest` carries `credentialProxy?: CredentialProxyConfig`, so the proxy is armed at create.
- **LIVE SERVER GAP (blocker for live verify):** `GET http://127.0.0.1:8080/credential-vault` → **404**
  (while `/health` → 200). The current `uvx opensandbox-server --example docker` deployment does **not**
  expose the vault. This is the dependency #282 names. Resolution path in T0.
- **Egress:** `NetworkPolicy` + `NetworkRule`/`NetworkRuleAction` already exist (used in R2 T4 via
  `DF_SANDBOX_EGRESS_ALLOW`); the proxy/gateway host is reachable, deny-by-default is the default action.
- **Lease pattern already exists:** `llm-gateway.ts` issues opaque lease tokens today (the CLI presents
  one to call the gateway). R3 tightens it (scope, `#private` token, adjudication/issuance split,
  404-as-success revoke, allow-list at seam).

## 3. Design decisions (proposed)

- **Provider key:** stays server-side. R3 moves it from `process.env.OPENROUTER_API_KEY` into a
  **host-side credential vault** (write-only); `forwardUpstream` retrieves it via a lease brokered by
  `createLeaseBroker`. The CLI in the sandbox is unchanged — it still only talks to the gateway (R2).
  Consequence: the provider key is never in env, argv, or a log line.
- **Push token:** removed from the runner's shell string. The push credential is injected via the
  credential vault / a git credential helper so `git push` uses it without the runner building an
  authed URL. The **fail-closed `git ls-remote` HEAD check is preserved**, as is the single-background-
  push rule for this host. Decision point (T2): push in-sandbox (vault-injected) vs host-side credential
  helper — resolve against the live server's capability in T0/T2.
- **Adjudication vs issuance split:** the HTTP-facing lease verb exposes **only** "may I push / may I call
  the model?" and returns **one generic 401** — it must not become a lease-state oracle.
- **Fail-closed everywhere:** `DF_SANDBOX_VAULT_*` default to the absent/refusing state; the global
  allow-list is enforced **at the seam** and fails closed on empty; revoking an absent lease is
  404-as-success.

## 4. Tasks

### T0 — Recon & de-risk the vault dependency (BLOCKER)
- Pin/upgrade the OpenSandbox server to a build that exposes `/credential-vault` (the docker-example
  currently 404s). Determine the required version/flag; if a vault-capable build is unavailable, R3
  proceeds SDK-typed + unit-tested and **live verification is explicitly gated** (documented, not faked).
- Confirm exact `CredentialVault*` / `CredentialBinding` / `CredentialProxyConfig` request shapes against
  the installed SDK (done above; re-verify after any server/SDK bump).
- Write `scripts/vault-server-up.sh` (bring-up + health + vault-capability probe) mirroring R2's
  `sandbox-server-up.sh`.

### T1 — Provider-key vault (server-side, write-only)
- `createCredentialVault(env)` host-side store for `OPENROUTER_API_KEY`; `forwardUpstream` reads via lease.
- `createLeaseBroker` with issue/revoke/adjudicate; opaque id + scope (`repos`, `expiresAt`); token in a
  `#private` field; never in response/metric/error.
- Adjudication endpoint returns only adjudication + one generic 401.
- Revoking an absent lease → 404-as-success; global allow-list at the seam, fails closed on empty.
- Unit tests with a fake vault + fake broker (no live secret).

### T2 — Git push-token vault (secret-free push)
- Remove `x-access-token:${token}@github.com` at runner line 533; inject via vault / credential
  helper. Preserve `git ls-remote` HEAD check + single-background-push rule.
- Decide in-sandbox vs host-side injection from T0's server capability.
- Unit test asserts no token in the constructed command string / argv (parse `execSync` args, not actually run).

### T3 — Egress hardening
- Sandbox reaches only the gateway (+ git host if required); deny the rest. Build on R2 T4
  `DF_SANDBOX_EGRESS_ALLOW` → default deny + allow-rules for gateway + (optional) git host.

### T4 — Lease broker hardening (fold into T1 if it lands there)
- Central `createLeaseBroker`; issuance/adjudication separation; 404-as-success revoke; allow-list at seam
  fails closed. Covered by T1 tests; this task is the integration + the "not a lease-state oracle" assertion.

### T5 — ADR + docs + env
- ADR `NNNN-df-sandbox-credential-vault.md` (record the server-dependency decision + lease pattern).
- `.env.example` rows for `DF_SANDBOX_VAULT_*` (default fail-closed/absent); operator steps.
- Docs catalog + ADR index rows.

### T6 — Tests / assertions
- Assert neither provider key nor push token appears in argv, shell strings, sandbox env, logs, metrics, or
  errors. Mock-first unit tests; integration where the live server permits.
- Prettier 3.5.3 / cspell / tsc / doc-drift / ADR-integrity guards.

## 5. Acceptance-criteria mapping

| #282 criterion | Covered by |
|---|---|
| No secret in argv/shell/sandbox-env/logs/metrics/errors | T1, T2 + T6 assertions |
| Adjudication separated from issuance; one generic 401 | T1/T4 |
| Revoke absent lease = 404-as-success; allow-list at seam, fails closed on empty | T1/T4 |
| Fail-closed push verification preserved | T2 |
| Docs/env/ADR | T5 |

## 6. Risks / open questions
- **Live vault support (BLOCKER):** current server 404s `/credential-vault`; T0 must resolve or gate live verify.
- **Push location:** in-sandbox vs host-side credential helper — depends on T0 server capability.
- **Credential proxy trust:** the transparent MITM proxy must only inject into the bound host; never broaden scope.
- **megaLinter cspell:** reword (US vocabulary) rather than pad `.cspell.json`; add only SDK-exact terms if forced.

## 7. Out of scope
- Authoring / gateway behaviour (R2). R3 only moves secrets; it does not change what the CLI authors or how
  the gateway admits calls.

---

## GATE 1
_Approval gate: plan reviewed, branch + this file pushed BEFORE any implementation. Implementation (RED→GREEN
per TDD) starts only after GATE 1 is approved._
