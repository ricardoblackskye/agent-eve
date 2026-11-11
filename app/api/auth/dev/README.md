# Dev Auth Route

## Overview
Development and E2E mock authentication route that mints a signed session cookie without Google OAuth for local testing.

## Interface
- `GET(request: NextRequest): Promise<NextResponse>` [app/api/auth/dev/route.ts:29-76]
- `runtime = 'nodejs'` [app/api/auth/dev/route.ts:18]
- `dynamic = 'force-dynamic'` [app/api/auth/dev/route.ts:19]

## Invariants
- Fail-closed: returns 404 unless AUTH_DEV_MODE is enabled and NODE_ENV is not 'production' [app/api/auth/dev/route.ts:32-34]
- Verifies user email against the configured allow-list via verifyGoogleChatAccess; unapproved emails redirect to /unauthorized [app/api/auth/dev/route.ts:40-51]
- Redirect destination is validated via safeNextPath and safeRedirect to prevent open redirects [app/api/auth/dev/route.ts:39, 65-68]

## Side Effects
- Sets HttpOnly eve_session cookie on response [app/api/auth/dev/route.ts:69-73]
- Redirects HTTP client to requested next path or / [app/api/auth/dev/route.ts:65-68]
- Logs dev sign-in grant to console [app/api/auth/dev/route.ts:74]

## Verification
- Run: `npm test`
