# 0035 — Sandbox credentials live in a write-only vault, not in argv

- **Date:** 2026-10-13
- **Status:** Accepted

## Context

#279 (R3) makes the Dark Factory sandbox secret-free. Today two raw secrets can reach
argv, shell strings, sandbox env, logs, or errors:

- the model-provider key, read by the LLM gateway from `process.env` per request; and
- the git push token, embedded in a `https://x-access-token:${token}@github.com/...`
  shell string the runner builds at push time.

Both leak by construction. OpenSandbox exposes a Credential Vault API (write-only
secrets, transparent injection via a credential proxy), but the local deployment this
repo tests against does **not** yet serve `/credential-vault`, so live injection is
gated (see Consequences).

## Decision

- Secrets are stored **write-only** in a `CredentialVault`: `put(name, value)` accepts a
  value that can never be read back through the public surface. Redemption
  (`redeem`) is **server-side only** and never reaches a client, a sandbox, a log line,
  or an error message.
- The gateway redeems the provider key via an opaque, run-scoped **lease** instead of
  reading `process.env` at request time; the `authorization` header is built from the
  redeemed value and the old `*** ${env.OPENROUTER_API_KEY}` leak is gone.
- The git push token is never placed in a URL or argv. It is seeded into the vault and
  supplied to git only through a `GIT_ASKPASS` helper (a path, not the value); the
  authed push URL is never constructed. The fail-closed `git ls-remote` HEAD check on
  the bare URL is preserved.
- Egress is **deny-by-default**. The gateway host the sandbox CLI is pointed at is
  *always* allowed; a git host is allowed only when explicitly configured; everything
  else is denied. An operator mistake in the allow-list cannot silently open egress to a
  model provider.
- The lease authority separates **issuance** from **adjudication**; the HTTP-facing verb
  returns one generic `401` ("unauthorized") and never exposes lease state. Revoking an
  absent lease is a no-op (404-as-success), so revocation cannot be probed.

## Consequences

- A secret-free sandbox: no provider key or push token in argv, shell strings, sandbox
  env, logs, metrics, or errors.
- Fail-closed posture: empty allow-lists deny; absent leases revoke idempotently; an
  unconfigured deployment refuses rather than forwarding ungoverned.
- **Gated live verification:** the OpenSandbox Credential Vault / egress-proxy injection
  cannot be exercised against the current local server (it 404s on `/credential-vault`).
  The host-side vault path is fully implemented and unit-tested; transparent
  in-sandbox injection requires a vault-capable OpenSandbox build (version/flag bump),
  tracked separately from this change.
- Operators gain `DF_SANDBOX_EGRESS_GATEWAY_HOST` and `DF_SANDBOX_EGRESS_GIT_HOST`
  (default fail-closed / absent) and `DF_SANDBOX_VAULT_*` rows documented in
  `.env.example`.
