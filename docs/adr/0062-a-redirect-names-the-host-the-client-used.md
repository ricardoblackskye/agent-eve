# 0062 — A redirect names the host the client used

- **Date:** 2026-10-25
- **Status:** Accepted

## Context

Every absolute URL the auth layer built came from `request.nextUrl.origin`, and that value is the address the
server is bound to, not the address the client typed. Measured on `main` with `AUTH_DEV_MODE=1`, walking
`/documentation/overview` into the sign-in hop:

| server bound to | client requested                     | `Location` on the sign-in hop                 |
| --------------- | ------------------------------------ | --------------------------------------------- |
| `0.0.0.0`       | `127.0.0.1:3001`                     | `http://0.0.0.0:3001/documentation/overview`   |
| `127.0.0.1`     | `127.0.0.1:3001` (`Host` header set) | `http://localhost:3001/documentation/overview` |
| `127.0.0.1`     | `localhost:3001`                     | `http://localhost:3001/documentation/overview` |

`sessionCookieOptions` sets no `domain`, so the session cookie is host-only. A redirect that crosses hosts drops
it, the gate sees an anonymous request, and the chain restarts — the 50-redirect loop in #471. Row 2 is the default
`playwright.config.ts` fixture (`baseURL` `127.0.0.1`, webServer `--hostname 127.0.0.1`), so a plain local run walks
into it while CI does not.

This is not only a test-harness problem. `buildRedirectUri` feeds the Google OAuth `redirect_uri`; on a
`0.0.0.0`-bound server — the normal container and `npm run dev -- --hostname 0.0.0.0` case — it hands Google a
callback on `0.0.0.0`, which cannot be registered or used. And `x-forwarded-host` was consulted nowhere in the
repository, so any deployment reached by a host other than its bind address was affected.

## Decision

One helper, `resolveRequestOrigin(request)`, decides the origin for every absolute URL the auth layer builds. It
resolves in this order, most authoritative first:

1. `x-forwarded-host`, carrying `x-forwarded-proto` (defaulting to `https`) — a proxy knows the outside address.
2. `Host` — a direct connection knows its own address, and takes its protocol from the server's own origin.
3. `nextUrl.origin` — last resort, which preserves the old behaviour when no header is present.

A header is untrusted input, so the chosen authority is validated before it becomes a `Location`: hostname labels or
a bracketed IPv6 literal, an optional port, and nothing else. A value carrying CR, LF, whitespace, `@`, a path, a
query or a fragment is refused and the next candidate is tried. A forwarded pair is only as trustworthy as both
halves: an absent proto means "the proxy did not say" and https is assumed, while a proto that is present but
nonsense discards the whole pair and falls back to `Host`.

It is used at the gate in `proxy.ts` and in the four auth routes (`dev`, `google/start`, `google/callback`,
`signout`).

## Consequences

Makes easy: a redirect now names the host the browser actually used, so the host-only cookie survives the hop and a
local run stops looping; and a `0.0.0.0`-bound server hands Google a callback address that can actually be
registered.

Costs accepted: the helper trusts `x-forwarded-host`, so a client able to set that header could steer the host of an
internal redirect. The strict authority validation narrows this, and the redirect path is already constrained by
`safeNextPath`, but the trust boundary is a real one — this is the single place to change if the project later
decides proxy-supplied hosts should not be trusted at all.

Follow-on work: the GitHub webhook route resolves its handoff origin from configuration first and only falls back to
`nextUrl.origin`; that is a separate behaviour with its own tests and was left alone. The `/api/eve/v1/*` rewrite is
same-origin to itself and is unaffected.
