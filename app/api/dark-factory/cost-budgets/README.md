# Dark Factory Cost Budgets API

## Overview
Operator-only read-only view of LLM category cost budgets, spend, and reservations.

## Interface
- `GET(request: NextRequest): Promise<NextResponse>` [app/api/dark-factory/cost-budgets/route.ts:12-30]

## Invariants
- Guarded by guardOperator: strictly operator access [app/api/dark-factory/cost-budgets/route.ts:13-14]

## Side Effects
- Queries CostBudgetStore for category budget limits and allocations [app/api/dark-factory/cost-budgets/route.ts:18-20]

## Verification
- Run: `npm test`
