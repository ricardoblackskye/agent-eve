# Eve Runtime Proxy

## Overview
Reverse proxy routing client requests to the backend Eve agent runtime with SSRF prevention and Bearer authentication.

## Interface
- `GET, POST, PUT, DELETE, PATCH` handler functions [app/api/eve/v1/[...slug]/route.ts:103-107]

## Invariants
- Requires Authorization: Bearer <EVE_API_KEY> on all requests when EVE_API_KEY is configured, except /health [app/api/eve/v1/[...slug]/route.ts:17-25]
- SSRF guard: validates upstream target origin using resolveApiOrigin; rejects untrusted Host headers with 502 [app/api/eve/v1/[...slug]/route.ts:34-43]
- Streams SSE responses directly without buffering when pathname matches /session/[^/]+/stream [app/api/eve/v1/[...slug]/route.ts:78, 87-96]

## Side Effects
- Proxies HTTP requests and forwards request payloads to the backend Eve agent server [app/api/eve/v1/[...slug]/route.ts:80-84]

## Verification
- Run: `npm test`
