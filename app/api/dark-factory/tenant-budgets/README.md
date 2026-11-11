# Dark Factory Tenant Budgets API

## Overview
Per-customer LLM cost budget endpoint reporting caps, settled costs, and reserved spend.

## Interface
- `GET(request: NextRequest): Promise<NextResponse>` [app/api/dark-factory/tenant-budgets/route.ts:20-83]

## Invariants
- Guarded by guardViewer: operator views all customer budgets; customer viewers view only their tenant [app/api/dark-factory/tenant-budgets/route.ts:21-22, 45-48]
- Validates period query parameter format against ^\d{4}-\d{2}$ [app/api/dark-factory/tenant-budgets/route.ts:24-27]
- Reports an unreadable budget store as available: false with an explicit message rather than zero spend [app/api/dark-factory/tenant-budgets/route.ts:58-67]

## Side Effects
- Queries TenantStore and CostBudgetStore [app/api/dark-factory/tenant-budgets/route.ts:39, 53-56]

## Verification
- Run: `npm test`
