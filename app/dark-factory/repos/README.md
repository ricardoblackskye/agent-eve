# Dark Factory Repositories Page

## Overview
Repository readiness dashboard page displaying agent-readiness scores for configured repositories.

## Interface
- `dynamic = 'force-dynamic'` [app/dark-factory/repos/page.tsx:9]
- `metadata = { title: 'Repositories' }` [app/dark-factory/repos/page.tsx:11]
- `default async function ReposPage(): Promise<ReactNode>` [app/dark-factory/repos/page.tsx:21-32]

## Invariants
- Reads allowed repositories using resolveWorkerAllowedRepos(process.env) [app/dark-factory/repos/page.tsx:22]
- Refuses rather than rendering a fixture if the configured AMM scan provider cannot measure readiness [app/dark-factory/repos/page.tsx:17-26]

## Side Effects
- Queries AMM scan store and closes provider connection in finally block [app/dark-factory/repos/page.tsx:23-31]

## Verification
- Run: `npm test`
