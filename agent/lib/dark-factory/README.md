# Dark Factory Subsystem

## Overview
Core Dark Factory subsystem implementing sandboxed software development factory capabilities: Developer Agent, Tester Agent, Cost Governance and Budgeting, Circuit Breaker, Run History & Lifecycle Tracking, Tenant Management, Membership, Observability Ledger, Control State, Autonomous Measurement Machine scans, Dispatcher & Triggers, Definition of Done, and Self-Improvement Controller.

## Interface
- `createDeveloperAgent(config: DeveloperAgentConfig): DeveloperAgent` [developer-agent.ts:createDeveloperAgent]
- `runCodingLoop(opts: CodingLoopOptions): Promise<LoopResult>` [developer-agent.ts:runCodingLoop]
- `applySkeletalMap(workspace: string, map: SkeletonMap, capabilities?: Capabilities): Promise<void>` [developer-agent.ts:applySkeletalMap]
- `createWorkspaceTools(workspaceDir: string, commandRunner?: CommandRunnerFn, allowedExtensions?: ReadonlySet<string>): WorkspaceTools` [developer-agent.ts:createWorkspaceTools]
- `createTesterAgent(env?: Record<string, string | undefined>): TesterAgent` [tester-agent.ts:createTesterAgent]
- `createCircuitBreaker(env?: Record<string, string | undefined>): CircuitBreaker` [circuit-breaker.ts:createCircuitBreaker]
- `createCostGate(input: CostGateInput): CostGate | null` [cost-gate.ts:createCostGate]
- `createCostGovernor(store: CostBudgetStore, env?: Record<string, string | undefined>): CostGovernor` [cost-governor.ts:createCostGovernor]
- `createCostBudgetStore(env?: Record<string, string | undefined>): CostBudgetStore` [cost-budget-store.ts:createCostBudgetStore]
- `createRunHistoryStore(env?: Record<string, string | undefined>): RunHistoryStore` [run-history-provider.ts:createRunHistoryStore]
- `createMembershipStore(env?: Record<string, string | undefined>): MembershipStore` [membership-store.ts:createMembershipStore]
- `createPlatformAdapter(env?: Record<string, string | undefined>): PlatformAdapter` [platform.ts:createPlatformAdapter]
- `createSelfImprovementController(deps: SelfImprovementDeps): SelfImprovementController` [self-improve.ts:createSelfImprovementController]
- `resolveLlmPolicy(env?: Record<string, string | undefined>): LlmPolicy` [llm-policy.ts:resolveLlmPolicy]
- `isLlmPolicyConfigured(env?: Record<string, string | undefined>): boolean` [llm-policy.ts:isLlmPolicyConfigured]
- `runLocalRun(options: LocalRunOptions): Promise<number>` [local-run.ts:runLocalRun]

## Invariants
- [circuit-breaker.ts:validateWorkerActivity] pbiId must match ^[A-Za-z][A-Za-z0-9_-]*$ and length <= 128 characters; durationMs must be finite >= 0.
- [developer-agent.ts:assertSafeRelativePath] Workspace paths must be relative and cannot contain null bytes, Windows drive prefixes, or UNC paths.
- [developer-agent.ts:ALLOWED_TOOLS] Only permitted worker tools git_clone, read_file, write_code, and run_tests are allowed.
- [developer-agent.ts:ALLOWED_TEST_COMMAND_PREFIXES] Test runner commands must start strictly with npx vitest, npm test, or npx tsc.
- [tester-agent.ts:defaultCommandRunner] Child commands are restricted strictly to npx with commands tsc, cspell, vitest, or gitleaks.
- [child-env.ts:filterChildEnv] Child subprocess environments are strictly filtered to allowlisted keys (NODE_PATH, PATH, HOME, LANG, LC_ALL) to prevent secret leakage.
- [membership.ts:validateMembership] A customer membership requires an opaque UUID tenantId; operator memberships must not carry a tenantId.
- [cost-gate.ts:createCostGate] Unpriced models or unavailable cost stores fail-closed by throwing CostRefusedError before LLM calls proceed.
- [llm-policy.ts:resolveLlmPolicy] Thinking levels must strictly be one of off, low, medium, or high; step counts must be integers between 1 and 100.

## Side Effects
- [run-history-postgres.ts:PostgresRunHistoryStore] Connects to PostgreSQL, acquires advisory locks, and writes lifecycle events into df_run_summaries, df_run_events, and df_run_deliveries.
- [cost-budget-store-postgres.ts:PostgresCostBudgetAdapter] Executes transactional reservations and settlements against PostgreSQL table df_cost_budgets with row locks (FOR UPDATE).
- [tenant-store-postgres.ts:PostgresTenantStore] Reads and writes tenant metadata in df_tenants and df_tenant_repos.
- [control-postgres.ts:PostgresControlAdapter] Records factory and run pause/resume control state in df_factory_control, df_run_control, and df_control_events.
- [developer-agent.ts:applySkeletalMap] Creates directories and writes source files on disk within confined workspace directory.
- [tester-agent.ts:defaultCommandRunner] Spawns child processes (tsc, cspell, vitest, gitleaks) subject to execution timeouts and filtered environments.
- [pr-writer.ts:GitHubPrWriter] Makes outbound HTTPS calls to the GitHub API to open pull requests.
- [issue-writer.ts:GitHubIssueWriter] Posts comments and issue updates to GitHub via HTTPS.

## Verification
- Run: `npm test`
