# Dark Factory Runs API

## Overview
Execution ledger query endpoint supporting paginated, filtered run summary listings.

## Interface
- `GET(request: NextRequest): Promise<NextResponse>` [app/api/dark-factory/runs/route.ts:31-53]
- [[runId]](./%5BrunId%5D/README.md) - Individual run detail endpoint returning summary metadata and events

## Invariants
- Guarded by resolveViewer: validates session and active membership per request [app/api/dark-factory/runs/route.ts:32-35]
- Scoped by viewer identity: customer users only receive runs attributed to their tenantId [app/api/dark-factory/runs/route.ts:40-43]

## Side Effects
- Queries RunHistoryStore for paginated run records [app/api/dark-factory/runs/route.ts:39-44]

## Verification
- Run: `npm test`
