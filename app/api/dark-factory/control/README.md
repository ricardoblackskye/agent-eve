# Dark Factory Control API

## Overview
Operator endpoint for querying factory state and issuing pause, resume, stop, abort, and retry control operations.

## Interface
- `GET(request: NextRequest): Promise<NextResponse>` [app/api/dark-factory/control/route.ts:110-133]
- `POST(request: NextRequest): Promise<NextResponse>` [app/api/dark-factory/control/route.ts:135-200]

## Invariants
- Guarded by guardOperator: requires authenticated user with operator membership role [app/api/dark-factory/control/route.ts:111, 136]
- Valid actions are pause, resume, stop, abort, retry with scope factory or run [app/api/dark-factory/control/route.ts:23-35, 149-157]
- Abort and retry actions are strictly run-scoped and require non-empty runId [app/api/dark-factory/control/route.ts:160-166]

## Side Effects
- Reads and updates factory/run control records in ControlStore [app/api/dark-factory/control/route.ts:61-67, 74-84, 117-127, 178-184]
- Invokes performOperatorRunAction affecting run history and GitHub labels [app/api/dark-factory/control/route.ts:87-95]

## Verification
- Run: `npm test`
