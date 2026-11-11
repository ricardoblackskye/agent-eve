# Dark Factory Web Portal

## Overview
Dark Factory operations portal root providing navigation layout and real-time operations overview dashboard.

## Interface
- `DarkFactoryLayout({ children }: { children: ReactNode }): JSX.Element` [app/dark-factory/layout.tsx:4-34]
- `default function DarkFactoryOverviewPage(): JSX.Element` [app/dark-factory/page.tsx:37-220]
- [repos](./repos/README.md) - Repository readiness dashboard page
- [runs](./runs/README.md) - Execution ledger dashboard page
- [ui](./ui/README.md) - User interface component library and hooks

## Invariants
- Non-blocking error handling: run-history outages show an alert banner while cost, usage, customer, and policy panels continue to render independently [app/dark-factory/page.tsx:58-66, 100-106]

## Side Effects
- Client-side HTTP polling to /api/dark-factory/metrics and /api/dark-factory/runs [app/dark-factory/page.tsx:40-47]

## Verification
- Run: `npm test`
