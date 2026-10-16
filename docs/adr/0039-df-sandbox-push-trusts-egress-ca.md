# 0039 — The in-sandbox push trusts the egress sidecar's CA, and never disables verification

- **Date:** 2026-10-16
- **Status:** Accepted

## Context

0036 put the git push INSIDE the sandbox so the egress sidecar can inject the vaulted
credential. That sidecar is a man-in-the-middle by design: it terminates the sandbox's
outbound TLS with a root it mints (`CN = mitmproxy, O = mitmproxy`), rewrites the request to
carry the `Authorization` header, and re-originates the connection to the real host. The
sandbox never holds the token, which is the property 0035 wanted.

The cost is that git inside the sandbox cannot verify GitHub unaided, and nothing handed it
that root, so the first real in-sandbox push died:

    fatal: unable to access 'https://github.com/...': server certificate verification failed.

git had found no CA bundle and no revocation list configured: the root simply was not trusted.
`execd` does try to install the root into the system store, but through a helper whose
fallback branch runs the command anyway when the process is neither root nor has `sudo`. The
documented image shape is `USER node` with no `sudo`, so `/usr/local/share/ca-certificates/`
stays empty and the install only prints a warning no caller surfaces.

The root IS reachable, because `execd` merges it into a complete bundle at a fixed path:
`/opt/opensandbox/merged-ca-certificates.pem` — the full root set PLUS the sidecar's root,
measured as 151 certificates against 150 in the system bundle. It also leaves
`/opt/opensandbox/mitmproxy-ca-cert.pem`. The variable it exports for consumers that must
replace their bundle (`OPENSANDBOX_MERGED_CA`) reaches only the bootstrap's own services, so
an `exec` session does not inherit it.

## Decision

- The vault path's `runGit` offers git that CA as a PER-INVOCATION override —
  `git -c http.sslCAInfo=/opt/opensandbox/merged-ca-certificates.pem <command>`.
- **Certificate verification stays ON.** `GIT_SSL_NO_VERIFY` is rejected: it would switch
  verification off against the very proxy that holds the push token, and it would stop
  detecting a genuinely wrong certificate from anywhere else.
- The override is GUARDED on the file existing. The MITM is what creates that bundle, so on a
  sandbox without it an unconditional CA path makes git fail with `Problem with the SSL CA
  cert (path? access rights?)`, turning a working path into a broken one. The guard degrades to
  the previous behaviour instead.
- It is applied on the VAULT path only, which is the only configuration where the MITM — and
  therefore the bundle — exists.
- The CA is not EXPORTED. A per-invocation `-c` scopes the trust override to the command that
  needs it, so no other process in the sandbox inherits it.

## Consequences

- The push verifies TLS against the deployment's own proxy root. Inside the sandbox that trust
  is intended — the root exists only in the sidecar — so the sidecar's key material must stay
  there, and the sandbox's egress allow-list remains the control on where an injected
  credential can be sent.
- The bundle is deployment state rather than an image artefact, so a constant PATH (not a
  value) is the right thing to bake in. If `execd` ever moves it, the guard turns that into a
  silent return of the old symptom rather than a new failure — which is why this record names
  the path and the measurements.
- Unit coverage pins the command shape and both guard branches. The end-to-end proof is a real
  push inside a vault-enabled sandbox, which the previous wiring claimed and did not have.
