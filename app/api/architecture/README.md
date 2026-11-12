# Architecture API Route

## Overview
Documentation endpoint serving the repository ARCHITECTURE.md file contents as markdown.

## Interface
- `GET(): Promise<NextResponse>` [app/api/architecture/route.ts:5-17]

## Invariants
- Returns markdown content from ARCHITECTURE.md or a fallback message if reading fails [app/api/architecture/route.ts:7-16]

## Side Effects
- Synchronous filesystem read of ARCHITECTURE.md in process.cwd() [app/api/architecture/route.ts:8]

## Verification
- Run: `npm test`
