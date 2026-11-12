# Signout Route

## Overview
Signout endpoint that invalidates client authentication by clearing the session cookie.

## Interface
- `GET(request: NextRequest): Promise<NextResponse>` [app/api/auth/signout/route.ts:18-20]
- `POST(request: NextRequest): Promise<NextResponse>` [app/api/auth/signout/route.ts:22-24]
- `runtime = 'nodejs'` [app/api/auth/signout/route.ts:5]
- `dynamic = 'force-dynamic'` [app/api/auth/signout/route.ts:6]

## Invariants
- Always redirects to / on resolved request origin with HTTP status 303 [app/api/auth/signout/route.ts:10-13]

## Side Effects
- Deletes eve_session cookie from client response headers [app/api/auth/signout/route.ts:14]

## Verification
- Run: `npm test`
