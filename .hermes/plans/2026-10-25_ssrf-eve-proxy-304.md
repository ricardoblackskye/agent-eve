# Plan — #304: Remediate the genuine SSRF gap in the Eve proxy, clear the false-positive alerts

- **Date:** 2026-10-25
- **Issue:** #304 (5 critical CodeQL `js/request-forgery` alerts)
- **Branch:** `fix/ssrf-eve-proxy-304` (off `origin/main`)

## Goal

Close the one _genuine_ SSRF gap (alert #1) and clear the four _already-mitigated_ alerts
(#2, #3, #4, #7) so `js/request-forgery` goes to zero on this code, without weakening any control.

## Root cause (verified by reading the code)

- **#1 — genuine gap.** `app/api/eve/v1/[...slug]/route.ts:27-28` builds the proxy target as
  `new URL(slug, request.nextUrl.origin)`. `request.nextUrl.origin` is derived from the client's
  `Host` header, which is attacker-controlled. A spoofed `Host` redirects the fetch toward this server-side `fetch`
  (carrying the `Bearer` token) at an attacker host — real SSRF. No origin validation exists there.
- **#2 / #3 / #4 / #7 — mitigated, un-modeled (false positives).** All four resolve the handoff
  origin through `resolveApiOrigin(env, request.nextUrl.origin)` (`agent/lib/dark-factory/entry.ts:293`),
  which (1) prefers a configured origin (`DF_API_BASE_URL` / `VERCEL_URL` / generic platform config),
  (2) trusts the request origin **only when it is loopback** (`isLoopbackOrigin`, entry.ts:265),
  and (3) otherwise returns `null` and the caller fails closed (502 / skipped handoff). CodeQL
  cannot model `resolveApiOrigin` as a taint barrier, so the alerts persist despite the hardening.

## Intended fix

1. **Harden #1 (real fix).** In `app/api/eve/v1/[...slug]/route.ts`, route the proxy target through
   `resolveApiOrigin(process.env, request.nextUrl.origin)`:
   - if `origin` is `null` → return `502` ("origin could not be resolved from configuration; refusing the
     proxy");
   - assert the rewritten `slug` starts with `/eve/v1/` (defensive fail-closed);
   - `new URL(slug, resolvedOrigin)` — never `request.nextUrl.origin`.
     This preserves local-dev behaviour (loopback Host is trusted) and production behaviour (configured
     origin is used), while a spoofed non-loopback Host now fails closed instead of proxying.
2. **Clear #2 / #3 / #4 / #7 (recorded decision, not a control change).** At each of the four fetch
   sites, add an inline `// codeql[js/request-forgery]` suppression _with a written justification_
   quoting the `resolveApiOrigin` sanitiser. This is the "dismiss with a written justification" option
   from the issue — a recorded decision, never a silent suppression. The control is left exactly as is.

## Tasks (TDD phases)

- **RED** — `tests/eve-proxy-route.test.ts` (new): a request with a spoofed non-loopback `Host` and no
  `DF_API_BASE_URL`/`VERCEL_URL` must get `502`; a configured `DF_API_BASE_URL` routes the `fetch` to
  that origin with the `/eve/v1/...` path; a loopback `Host` (no config) routes to the loopback origin.
  Mock `global.fetch` and assert the URL it is called with.
- **GREEN** — apply the `resolveApiOrigin` change in the route; add the four `codeql[js/request-forgery]`
  justification comments.
- **REFACTOR** — none expected; keep the route minimal.

## Files likely to change

- `app/api/eve/v1/[...slug]/route.ts` — the real fix.
- `app/api/github/webhook/route.ts` — 3 `codeql[js/request-forgery]` justifications (lines ~353, ~525, ~698).
- `agent/lib/dark-factory/entry.ts` — 1 `codeql[js/request-forgery]` justification (~line 930 handoff).
- `tests/eve-proxy-route.test.ts` — new RED/GREEN test.
- `docs/adr/0063-*.md` — new ADR + index link.

## ADRs (decided now)

- **ADR 0063 — Outbound Eve API URLs resolve fail-closed from configuration.** Records the origin
  precedence (configured origin → loopback request origin → fail closed) and that the four
  `js/request-forgery` alerts are accepted false positives with documented sanitizers.

## Validation

- `npx vitest run tests/eve-proxy-route.test.ts tests/dark-factory/entry.test.ts` — new + existing pass.
- `npx tsc --noEmit --incremental false` — clean.
- `npx vitest run` — no NEW regressions (full suite).
- `npx cspell@9.1.1 -c .cspell.json <changed files>` — clean (house pre-push gate).
- After merge, CodeQL `js/request-forgery` on these files should reach zero (the 4 suppressions plus the
  now-resolved #1).

## Risks / open questions

- **No behaviour regression in prod:** if a deployment runs non-loopback with neither `DF_API_BASE_URL`
  nor `VERCEL_URL` set, the proxy now returns 502 where it previously proxied to the request `Host`.
  This is the intended fail-closed posture; the plan notes it so the user can set `DF_API_BASE_URL` if an
  unconfigured self-host needs the proxy.
- **The 4 suppressions are a recorded decision, not a fix.** If `resolveApiOrigin` is ever weakened,
  those four alerts would silently stop firing — call that out in the PR body and the ADR.
- **#309 deferred:** issue #309 is explicitly DEFERRED until after a real end-to-end/UAT run (its own AC1);
  this plan does not touch it. Flagged, not actioned.
