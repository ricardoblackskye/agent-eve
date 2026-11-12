# Dark Factory Usage API

## Overview
Read-only usage query endpoint reporting LLM token consumption and call counts.

## Interface
- `GET(request: NextRequest): Promise<NextResponse>` [app/api/dark-factory/usage/route.ts:15-45]

## Invariants
- Guarded by guardViewer: customers are pinned to their own tenantId; operators can query any tenant [app/api/dark-factory/usage/route.ts:16-17, 24-27]
- Exposes counts and costs only; never reads or returns prompt or completion text [app/api/dark-factory/usage/route.ts:11-13]

## Side Effects
- Queries UsageStore for aggregated token counts and costs [app/api/dark-factory/usage/route.ts:28-35]

## Verification
- Run: `npm test`
