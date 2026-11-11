# Dark Factory LLM Policy API

## Overview
Operator endpoint returning effective deployment LLM parameters and surface model allocations.

## Interface
- `GET(request: NextRequest): Promise<NextResponse>` [app/api/dark-factory/llm-policy/route.ts:23-50]

## Invariants
- Guarded by guardOperator: strictly operator access [app/api/dark-factory/llm-policy/route.ts:24-25]
- Reports actual resolved model IDs for orchestrator, worker, and pr-review surfaces [app/api/dark-factory/llm-policy/route.ts:30-44]

## Side Effects
- None

## Verification
- Run: `npm test`
