# Google OAuth Start Route

## Overview
OAuth 2.0 initiation endpoint generating cryptographically secure state and PKCE challenge parameters before redirecting to Google consent.

## Interface
- `GET(request: NextRequest): Promise<NextResponse>` [app/api/auth/google/start/route.ts:27-84]
- `runtime = 'nodejs'` [app/api/auth/google/start/route.ts:16]
- `dynamic = 'force-dynamic'` [app/api/auth/google/start/route.ts:17]

## Invariants
- Falls back to /api/auth/dev if GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing and isDevAuthEnabled is true; otherwise returns 500 [app/api/auth/google/start/route.ts:33-52]
- Mints 32-byte cryptographically random state and S256 PKCE challenge pair for each request [app/api/auth/google/start/route.ts:54-55]
- Stores state and verifier in HttpOnly cookies with a 10-minute maximum age [app/api/auth/google/start/route.ts:68-80]

## Side Effects
- Sets HttpOnly eve_oauth_state and eve_oauth_verifier cookies on response [app/api/auth/google/start/route.ts:75-80]
- Redirects browser (HTTP 302) to Google accounts OAuth2 consent endpoint [app/api/auth/google/start/route.ts:58-66]

## Verification
- Run: `npm test`
