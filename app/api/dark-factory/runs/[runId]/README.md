# Dark Factory Run Detail API

## Overview
Individual run detail endpoint returning summary metadata and paginated execution events.

## Interface
- `GET(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<NextResponse>` [app/api/dark-factory/runs/[runId]/route.ts:24-55]

## Invariants
- Guarded by resolveViewer: requires authenticated user with active membership [app/api/dark-factory/runs/[runId]/route.ts:28-31]
- Customer viewers are restricted to runs belonging to their assigned tenant; cross-tenant queries return 404 [app/api/dark-factory/runs/[runId]/route.ts:36-43]

## Side Effects
- Queries RunHistoryStore for run summary and event stream [app/api/dark-factory/runs/[runId]/route.ts:36-41]

## Verification
- Run: `npm test`
