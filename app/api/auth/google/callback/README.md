# Google OAuth Callback Route

## Overview
Google OAuth 2.0 authorization code exchange and verification callback that enforces the email allow-list and issues session cookies.

## Interface
- `GET(request: NextRequest): Promise<NextResponse>` [app/api/auth/google/callback/route.ts:30-115]
- `runtime = 'nodejs'` [app/api/auth/google/callback/route.ts:19]
- `dynamic = 'force-dynamic'` [app/api/auth/google/callback/route.ts:20]

## Invariants
- Requires code query parameter and timing-safe matching state against eve_oauth_state cookie, failing to /unauthorized [app/api/auth/google/callback/route.ts:48-53]
- Requires configured GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and session signing secret, returning 500 if missing [app/api/auth/google/callback/route.ts:55-65]
- Verifies ID token audience matches GOOGLE_CLIENT_ID and verifies email against configured allowed email list [app/api/auth/google/callback/route.ts:75-92]
- Always clears transient eve_oauth_state and eve_oauth_verifier cookies on completion or denial [app/api/auth/google/callback/route.ts:117-120]

## Side Effects
- Outbound HTTPS POST to Google OAuth token endpoint to exchange authorization code [app/api/auth/google/callback/route.ts:74]
- Sets HttpOnly eve_session cookie with secure flag enabled in production [app/api/auth/google/callback/route.ts:102-106]
- Deletes eve_oauth_state and eve_oauth_verifier cookies [app/api/auth/google/callback/route.ts:118-119]
- Redirects browser to validated safe destination path or /unauthorized [app/api/auth/google/callback/route.ts:42-45, 98-101]

## Verification
- Run: `npm test`
