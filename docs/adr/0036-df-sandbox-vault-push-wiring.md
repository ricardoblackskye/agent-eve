# 0036 — The vault push path: a fail-closed gate, an in-sandbox push, and a pre-provisioned image

- **Date:** 2026-10-14
- **Status:** Accepted

## Context

0035 decided that sandbox credentials live write-only in a vault. #354 is the wiring that
makes that true for the Dark Factory's git push, and the wiring forced three choices a
reader would otherwise have to re-derive from the code:

- **The push must happen INSIDE the sandbox.** The credential is injected by the egress
  sidecar on the way out of the sandbox, so a host-side `git push` cannot use it. The
  credential-vault guide documents a git binding (`basic` auth over a bare URL) whose
  header the sidecar supplies, which also makes `GIT_ASKPASS` and placeholder
  substitution unnecessary: the sandbox command carries no credential at all.
- **The sandbox does not outlive the coding phase.** `runCodingPhase` disposes it in a
  `finally`, so the commit and the push belong inside the phase, not at STEP 6.
- **The sandbox needs a repository and its dependencies.** Nothing in the pipeline
  clones a repository or installs dependencies, so with the default image the loop's
  `npx vitest run` cannot pass.

## Decision

- Vault-backed wiring is gated by `DF_SANDBOX_VAULT_ENABLED`, read as ON only when it is
  non-blank. Unset keeps today's behaviour exactly: no `credentialProxy` on create, and
  the host-side push through the in-memory vault.
- The gate is FAIL-CLOSED. Setting it with any driver other than `opensandbox` refuses
  the run, and so does a vault-backed request against a sandbox that exposes no credential
  vault. An unauthenticated push that surfaces as a 401 much later is not an acceptable
  failure mode for a missing configuration.
- The push runs INSIDE the sandbox through a provider capability (`runGit`) that exists
  only on the vault path. `runCodingPhase` hands the phase its provider, so the git flow
  can run before the sandbox is disposed. The host-side push is retained unchanged for
  every other driver.
- The push credential is a NARROW `basic` binding: HTTPS, the configured git host, and
  this repository's `.git` path only. The sandbox receives neither the token nor a
  placeholder -- only the binding, which the sidecar applies to the outbound request.
- The sandbox image MUST carry the project, meaning the repository and its dependencies.
  `DF_SANDBOX_IMAGE` is therefore a deployment requirement rather than a default to rely
  on. A clone is attempted only when the workspace is not already a work tree, which
  happens before the loop writes because `git clone` refuses a non-empty directory.

## Consequences

- A deployment that wants the vault path sets `DF_SANDBOX_VAULT_ENABLED=1`,
  `DF_SANDBOX_DRIVER=opensandbox`, `DF_SANDBOX_EGRESS_GIT_HOST=<the git host>`, and an
  image carrying the project. Missing any of those fails loudly instead of quietly
  pushing unauthenticated.
- The secret exists at push time only inside the egress sidecar, so an inspection of the
  sandbox's process tree finds nothing. The #354 acceptance criterion therefore holds by
  construction rather than by substitution.
- Every non-vault driver is byte-identical to before, so no existing deployment changes
  behaviour.
- Deferred: nothing clones the repository or installs its dependencies for you, so the
  loop's test step still depends on the image. Making the sandbox self-provisioning is a
  separate change.
