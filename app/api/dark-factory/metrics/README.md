# Dark Factory Metrics API

## Overview
KPI and outcome metric endpoint aggregating run statistics and daily terminal trends.

## Interface
- `GET(request: NextRequest): Promise<NextResponse>` [app/api/dark-factory/metrics/route.ts:24-47]

## Invariants
- Guarded by resolveViewer: requires authenticated active membership [app/api/dark-factory/metrics/route.ts:25-28]
- Validates optional date range (from/to) and repo filter params [app/api/dark-factory/metrics/route.ts:16-22, 32-36]

## Side Effects
- Queries RunHistoryStore for aggregate metrics and trends [app/api/dark-factory/metrics/route.ts:32-36]

## Verification
- Run: `npm test`
