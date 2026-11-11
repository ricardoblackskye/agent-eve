# Unauthorized Page

## Overview
Access denial page displayed when an unapproved Google account attempts to access gated views.

## Interface
- `metadata: Metadata` [app/unauthorized/page.tsx:3-5]
- `default function Unauthorized(): JSX.Element` [app/unauthorized/page.tsx:8-30]

## Invariants
- Provides retry link to /api/auth/google/start for re-authenticating [app/unauthorized/page.tsx:27]

## Side Effects
- None

## Verification
- Run: `npm test`
