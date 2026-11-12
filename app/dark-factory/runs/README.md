# Dark Factory Runs Page

## Overview
Execution ledger dashboard page providing searchable, filterable overview of active and historical runs.

## Interface
- `default function DarkFactoryRunsPage(): JSX.Element` [app/dark-factory/runs/page.tsx:37-124]
- [[runId]](./%5BrunId%5D/README.md) - Run detail dashboard page displaying execution timeline and worker checkpoints

## Invariants
- Filters runs by status, execution stage, and issue/repo/runId search string [app/dark-factory/runs/page.tsx:55-62, 84-114]
- Selecting a table row navigates to /dark-factory/runs/:runId [app/dark-factory/runs/page.tsx:33-35, 121]

## Side Effects
- Client-side fetch polling to /api/dark-factory/runs?limit=50 [app/dark-factory/runs/page.tsx:43-53]

## Verification
- Run: `npm test`
