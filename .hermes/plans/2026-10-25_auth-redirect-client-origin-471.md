# Plan — a redirect names the host the client used (#471)

## Problem

Every absolute URL the app builds comes from `request.nextUrl.origin`, which resolves to the **dev server's own
address** and ignores the client's `Host` header. Measured on `main`, `AUTH_DEV_MODE=1`, walking
`/documentation/overview` into the sign-in hop:

| server bound to | client requested                     | `Location` on the sign-in hop                  |
| --------------- | ------------------------------------ | ---------------------------------------------- |
| `0.0.0.0`       | `127.0.0.1:3001`                     | `http://0.0.0.0:3001/documentation/overview`   |
| `127.0.0.1`     | `127.0.0.1:3001` (`Host` header set) | `http://localhost:3001/documentation/overview` |
| `127.0.0.1`     | `localhost:3001`                     | `http://localhost:3001/documentation/overview` |

`sessionCookieOptions` sets no `domain`, so the session cookie is host-only. A redirect that crosses hosts drops
it, the gate sees an anonymous request, and the chain restarts — the 50-redirect loop behind #471. Row 2 is the
default `playwright.config.ts` fixture (`baseURL` `127.0.0.1`, webServer `--hostname 127.0.0.1`), so a plain local
run walks into it.

This is not only a test-harness problem:

- `buildRedirectUri` feeds the Google OAuth `redirect_uri`. On a `0.0.0.0`-bound server — the normal container and
  `npm run dev -- --hostname 0.0.0.0` case — it hands Google a callback on `0.0.0.0`, which cannot be registered or
  used.
- `x-forwarded-host` is consulted nowhere in the repository, so any deployment reached by a host other than the bind
  address is affected.
- The same pattern backs the gate in `proxy.ts` and every auth redirect.

## Decision

Resolve the client-visible origin once, in one helper, and use it wherever an absolute URL is built:

1. `x-forwarded-host`, with `x-forwarded-proto` (defaulting to `https`) — a proxy is authoritative about the outside
   address.
2. `Host` — a direct connection is authoritative about itself.
3. `request.nextUrl.origin` — last resort, preserving today's behaviour when no header is present.

The chosen authority is validated before use: it must match a strict host and optional port shape, and any value
carrying CR, LF, whitespace, `@`, `/`, `?` or `#` is rejected. A header must not be able to inject a `Location` or
smuggle a second header; the redirect _path_ is already constrained by `safeNextPath`.

No new configuration: `GOOGLE_REDIRECT_URI` already exists as an explicit override for the OAuth callback, and a new
env var would add a knob without adding capability.

## Change

1. New `app/request-origin.ts` — a pure `resolveRequestOrigin(request)` (headers + `nextUrl` in, origin string out),
   so the rule is testable without a running server.
2. `proxy.ts` — the gate builds its `/api/auth/google/start` URL from the resolved origin.
3. `app/api/auth/dev/route.ts` (2 sites), `google/start/route.ts` (2), `google/callback/route.ts` (3),
   `signout/route.ts` (1).
4. ADR 0062 — a redirect names the host the client used.

## Tests

RED first, in the house style already used by `tests/proxy-route.test.ts` (mock `next/server`, build a fake
`NextRequest` carrying `headers` and `nextUrl`):

- `tests/request-origin.test.ts` — forwarded host wins and carries its proto; `Host` is used when no forwarded
  header exists; `nextUrl.origin` is the fallback; the port survives; a value with CR, LF, whitespace, `@` or a path
  is rejected rather than echoed.
- `tests/proxy-route.test.ts` — extend the gate test with the real divergence: `nextUrl` `http://localhost:3000`,
  `Host: 127.0.0.1:3001`, asserting the redirect names `127.0.0.1:3001`. This is the regression that would have
  caught #471, and it currently fails.
- `tests/auth-dev-route.test.ts` — the sign-in redirect honours the client's host, not `nextUrl`.

## Out of scope

- `app/api/github/webhook/route.ts` — resolves its handoff origin from configuration first and only falls back to
  `nextUrl.origin`; changing that alters webhook behaviour with its own tests.
- `app/api/eve/v1/[...slug]/route.ts` — rewrites same-origin to itself, unaffected by the client's host.

## Verification

1. Reproduce the defect before the change with the script from the issue comment: bound `127.0.0.1`, `Host:
127.0.0.1:3001`, today returns a `Location` on `localhost:3001`.
2. After the change the same request must name `127.0.0.1:3001`.
3. Run `npx playwright test` with `BASE_URL=http://127.0.0.1:3001` and the server bound the same way — the exact
   fixture that looped 50 times — and expect the affected specs to pass without hand-matching hosts.
4. RED/GREEN: the new assertions fail before the change and pass after.

## Risk

Trusting `x-forwarded-host` blindly would let a client that can set it steer the _host_ of an internal redirect.
Mitigated by strict authority validation and because the redirect path is already constrained. If the project later
decides proxy-supplied hosts should not be trusted at all, this helper is the single place to change.
