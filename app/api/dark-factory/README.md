# Dark Factory API Subsystem

## Overview
Dark Factory backend API package providing authentication guards, response utilities, and operation endpoints.

## Interface
- `guardViewer(request: NextRequest): Promise<Guard>` [app/api/dark-factory/guard.ts:18-28]
- `guardOperator(request: NextRequest): Promise<Guard>` [app/api/dark-factory/guard.ts:36-43]
- `resolveViewer(request: Request, deps?: { store?: MembershipStore }): Promise<ViewerResolution>` [app/api/dark-factory/viewer.ts:36-73]
- `getViewerSession(request: Request): Promise<SessionPayload | null>` [app/api/dark-factory/viewer-auth.ts:42-52]
- `readCookieValue(cookieHeader: string | null, name: string): string | null` [app/api/dark-factory/viewer-auth.ts:9-22]
- `resolveViewerSecret(): Promise<string | null>` [app/api/dark-factory/viewer-auth.ts:29-35]
- `badRequest, forbidden, notFound, okJson, serviceUnavailable, unauthorized, NO_STORE_HEADERS` [app/api/dark-factory/responses.ts:4-47]
- [control](./control/README.md) - Operator control endpoint
- [cost-budgets](./cost-budgets/README.md) - Operator view of category budgets
- [llm-policy](./llm-policy/README.md) - Operator view of LLM parameters
- [metrics](./metrics/README.md) - KPI and outcome metrics
- [runs](./runs/README.md) - Execution ledger endpoint
- [tenant-budgets](./tenant-budgets/README.md) - Customer cost budget endpoint
- [tenants](./tenants/README.md) - Customer tenant inventory
- [usage](./usage/README.md) - LLM usage and token metrics

## Invariants
- All API responses include Cache-Control: private, no-store headers [app/api/dark-factory/responses.ts:4-6]
- Membership role and tenant are resolved on every request from MembershipStore to immediately reflect revocations [app/api/dark-factory/viewer.ts:6-11, 57-68]
- Fail-closed: unconfigured session secret denies all authentication [app/api/dark-factory/viewer-auth.ts:25-35]

## Side Effects
- Queries MembershipStore for user roles and tenant scopes [app/api/dark-factory/viewer.ts:57]

## Verification
- Run: `npm test`
