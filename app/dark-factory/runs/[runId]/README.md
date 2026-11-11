# Dark Factory Run Detail Page

## Overview
Run detail dashboard page displaying execution timeline, worker checkpoints, diffs, test results, and run-level controls.

## Interface
- `default function DarkFactoryRunDetailPage(): JSX.Element` [app/dark-factory/runs/[runId]/page.tsx:26-130]

## Invariants
- Polls run detail from /api/dark-factory/runs/:runId and control state from /api/dark-factory/control [app/dark-factory/runs/[runId]/page.tsx:29-38]
- Explicitly handles auth, 404, loading, and error states [app/dark-factory/runs/[runId]/page.tsx:40-56]

## Side Effects
- Client-side polling to /api/dark-factory/runs/:runId and /api/dark-factory/control [app/dark-factory/runs/[runId]/page.tsx:29-38]

## Verification
- Run: `npm test`
