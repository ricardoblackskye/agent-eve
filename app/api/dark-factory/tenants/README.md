# Dark Factory Tenants API

## Overview
Operator endpoint providing a read-only inventory of customer tenants and repository assignments.

## Interface
- `GET(request: NextRequest): Promise<NextResponse>` [app/api/dark-factory/tenants/route.ts:17-44]

## Invariants
- Guarded by guardOperator: requires operator membership role [app/api/dark-factory/tenants/route.ts:18-19]
- Unassigned repositories remain visibly absent rather than defaulted [app/api/dark-factory/tenants/route.ts:11-13]

## Side Effects
- Queries TenantStore for customer tenant records and repository mappings [app/api/dark-factory/tenants/route.ts:31-36]

## Verification
- Run: `npm test`
