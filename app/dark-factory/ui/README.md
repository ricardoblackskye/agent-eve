# Dark Factory UI Library

## Overview
Dark Factory user interface component library, data polling hooks, and presentation view models.

## Interface
- Components: `StatePanel, StatusPill, PanelHead, MetricTile, RunTable, EventTimeline, AgentOutputPanel, RunDiffPanel, TestOutputPanel, TracePanel, BreakerTripPanel, WorkerCheckpoints, MeasuredMetrics, OutcomeArtifacts, RunDetailPanel, KpiTiles, OutcomeMix, ResourceSnapshot, TrendChart, RecentRunsList, BarChart, ControlPanel, CostBudgetsPanel, CostBudgetsPanelContainer, LlmPolicyPanel, LlmPolicyPanelContainer, RepoList, TenantBudgetPanel, TenantBudgetPanelContainer, TenantUsagePanel, TenantUsagePanelContainer, UsagePanel, UsagePanelContainer`
- Hooks: `useRunQuery, useFactoryControl, useCostBudgets, useLlmPolicy, useTenantBudgets, useTenantUsage, useUsage`
- Formatters: `formatCostUsd, formatCount, formatDurationMs, formatTimestamp` [app/dark-factory/ui/format.ts]
- View models: `filterRows, toQueryParams, toTableRows, toDetailView, toKpiTiles, toOutcomeMix, toResourceSnapshot, resolveOverviewError` [app/dark-factory/ui/view-model.ts]

## Invariants
- Unmeasured values render as em dash —, never misleading $0.00 or 0 [app/dark-factory/ui/cost-budgets-panel.tsx:8-9, app/dark-factory/ui/tenant-usage-panel.tsx:11-12, app/dark-factory/ui/tenant-budget-panel.tsx:18-19]
- Polling intervals default to 60,000ms with cleanup on unmount [app/dark-factory/ui/use-run-query.ts:18, app/dark-factory/ui/use-factory-control.ts:36, 122-125]
- Authentication errors (401) trigger unauthenticated state across all panels [app/dark-factory/ui/use-run-query.ts:48-52]

## Side Effects
- Periodic client-side fetch requests to /api/dark-factory/* endpoints [app/dark-factory/ui/use-run-query.ts:40-66, app/dark-factory/ui/use-factory-control.ts:51-78, 86-107]

## Verification
- Run: `npm test`
