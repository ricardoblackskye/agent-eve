# App Subsystem

## Overview
Web application root package providing the root Next.js layout, chat interface, authentication gate policies, session management, and sub-blueprints.

## Interface
- `RootLayout({ children }: Readonly<{ children: ReactNode }>): JSX.Element` [app/layout.tsx:9-18]
- `Home(): JSX.Element` [app/page.tsx:3-5]
- `Chat(): JSX.Element` [app/chat.tsx:7-74]
- `getEveChatHeaders(): Record<string, string>` [app/chat-auth.ts:9-12]
- `createSessionToken, verifySessionToken, sessionCookieOptions, SESSION_COOKIE_NAME, DEFAULT_SESSION_TTL_MS` [app/auth-session.ts:23-47, 49-91]
- `resolveSessionSecret, resolveAllowedEmails, isDevAuthEnabled, isProduction, buildRedirectUri, DEFAULT_ALLOWED_EMAIL, CALLBACK_PATH, DEV_SESSION_SECRET` [app/auth-config.ts:6-67]
- `createPkcePair, createState, validateState, buildGoogleAuthUrl, GOOGLE_AUTH_ENDPOINT` [app/auth-oauth.ts:10-70]
- `decideCallback` [app/auth-callback.ts:12-28]
- `isProtectedPath, isApiPath, safeNextPath` [app/auth-gate.ts:31-60]
- `verifyGoogleChatAccess, ALLOWED_GOOGLE_USERS` [app/google-auth.ts:1, 16-39]
- `resolveRequestOrigin, isSafeAuthority` [app/request-origin.ts:35-69]
- [api](./api/README.md) - API routing hierarchy
- [architecture](./architecture/README.md) - Legacy redirect route
- [dark-factory](./dark-factory/README.md) - Dark Factory operations portal
- [documentation](./documentation/README.md) - Documentation subsystem
- [releasenotes](./releasenotes/README.md) - Release notes viewer page
- [unauthorized](./unauthorized/README.md) - Access denial page

## Invariants
- Fail-closed authentication gate: every path not explicitly enumerated in PUBLIC_PREFIXES or PUBLIC_EXACT is treated as protected [app/auth-gate.ts:6-7, 35-47]
- Session tokens are signed HS256 JWTs with 8-hour default TTL, verified without database lookup [app/auth-session.ts:4-12, 25-26, 67-91]
- Request origin resolution respects x-forwarded-host and host headers with strict character whitelist validation to prevent header and redirect injection [app/request-origin.ts:27-37, 44-69]
- safeNextPath prevents open redirects by rejecting absolute, protocol-relative, and backslash paths [app/auth-gate.ts:54-60]

## Side Effects
- Client-side chat communication with backend Eve agent runtime at /api/eve/v1 [app/chat.tsx:8-23]
- Cookie issuance and validation across protected web pages [app/auth-session.ts, app/auth-oauth.ts]

## Verification
- Run: `npm test`
