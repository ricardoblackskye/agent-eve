# 0063 — Outbound Eve API URLs resolve fail-closed from configuration

- **Date:** 2026-10-25
- **Status:** Accepted

## Context

The Eve proxy (`app/api/eve/v1/[...slug]/route.ts`) and the Dark Factory handoff
(`agent/lib/dark-factory/entry.ts`, `app/api/github/webhook/route.ts`) issue server-side
`fetch`es that carry a `Bearer` token. The destination origin was, in one place, taken
straight from the inbound request's `Host` header via `request.nextUrl.origin` — attacker-
controllable, so a spoofed `Host` could aim that authenticated fetch at an attacker host
(server-side request forgery). CodeQL raised five `js/request-forgery` alerts (#304).

Four of the five sites already routed the origin through `resolveApiOrigin(env, requestOrigin)`,
which prefers a configured origin (`DF_API_BASE_URL` / `VERCEL_URL` / generic platform config),
trusts the request origin **only when it is loopback** (`isLoopbackOrigin`), and otherwise
returns `null` (callers fail closed). The fifth — the proxy route — used `request.nextUrl.origin`
directly with no sanitizer at all.

## Decision

- The proxy route now resolves its target origin through `resolveApiOrigin(process.env, request.nextUrl.origin)` and **fails closed with `502`** when the origin is `null` or the rewritten path does not start with `/eve/v1/`. It never constructs a URL from `request.nextUrl.origin`.
- Origin precedence is: configured origin → loopback request origin → fail closed. This preserves local-dev behaviour (a loopback `Host` is trusted) and production behaviour (the configured origin is used), while a spoofed non-loopback `Host` is refused.
- The four already-mitigated `js/request-forgery` alerts are recorded as **known false positives** with inline `// codeql[js/request-forgery]` justifications quoting the `resolveApiOrigin` sanitizer. CodeQL cannot model that helper as a taint barrier, but the control is correct, so it is suppressed with a written reason rather than weakened.

## Consequences

- A self-hosted deployment with neither `DF_API_BASE_URL` nor `VERCEL_URL` set and a non-loopback request now receives `502` from the proxy where it previously proxied to the request `Host`. That is the intended fail-closed posture; set `DF_API_BASE_URL` if such a deployment needs the proxy.
- The inline suppressions are a recorded decision: if `resolveApiOrigin` is ever weakened, those four alerts stop firing silently. Treat re-removal or weakening of that helper as a security regression.
- The genuinely vulnerable path (#1) is eliminated; the remaining alerts are documented, not open.
