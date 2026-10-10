<!-- markdownlint-disable MD013 MD049 -->
# Dark Factory module catalog

> The authoritative index of every module under `agent/lib/dark-factory/`. Each
> entry states the module's purpose (from its own header comment) and its key
> exports, and links to the source. This page is what the **doc drift guard**
> (issue #238) checks: every module must appear here (or in another docs page) or
> CI fails — so a new subsystem cannot ship undocumented. The narrative companion
> is [Dark Factory (R1)](dark-factory.md) and the flow walkthroughs in the
> [flow deep-dives](flow-run-lifecycle.md).

_62 modules._

## architect-agent

Dark Factory — Architect Agent (#179). Pre-code planning agent that inspects the repository file tree, analyzes the User Story and Acceptance Criteria, and synthesizes an ExecutionPlan. Self-corrects via feedback loops when generated plans fail domain validation.

**Source:** [`agent/lib/dark-factory/architect-agent.ts`](../../agent/lib/dark-factory/architect-agent.ts)

**Exports:** `ArchitectAgent`, `ArchitectDeps`, `ArchitectResult`, `DEFAULT_LOWEST_PRIORITY_SCORE`, `DEFAULT_MAX_CONTEXT_FILES`, `MAX_STORY_BODY_LENGTH`, `MAX_STORY_TITLE_LENGTH`, `ProcessTimerRegistry`, `StoryInput`, `sanitizeRelativePath`, `sortFilesByRelevance`

## circuit-breaker

Dark Factory — Factory-level circuit breaker / cost guard (issues #143 / story #144). A cross-task safety guard that caps cumulative worker-minutes per PBI and escalates after a configured number of failed self-correct cycles. Independent additive guard on top of the per-task retry/iteration bounds in #138 and #133. DESIGN DECISIONS: - State is IN-MEMORY (no persistence). Trip events are emitted for external logging; the breaker only needs the PBI's *current* state, not historical data. - Math.ceil() for ms→min conversion ensures we NEVER under-count toward the budget. A minimum duration threshold (5 seconds) prevents sub-second exploitation. Maximum over-count is: 59,999ms rounds up to 1 minute (59,999 < 60,000 < 120,000). - PBI_ID_PATTERN allows only alphanumeric, underscores, and hyphens (no periods) to prevent path traversal attacks if IDs are used in file paths or URLs. **IMPORTANT**: When constructing file paths or URLs, use encodeURIComponent() or similar encoding for additional safety, even with pattern restrictions. - Trip events are capped at 100 per PBI to prevent DoS attacks via event flooding.

**Source:** [`agent/lib/dark-factory/circuit-breaker.ts`](../../agent/lib/dark-factory/circuit-breaker.ts)

**Exports:** `CircuitBreaker`, `CircuitBreakerConfig`, `DFLT_MAX_STATE_ENTRIES`, `DFLT_MAX_TOTAL_TRIP_EVENTS`, `DFLT_MAX_TRIPS_PER_PBI`, `DFLT_MAX_WORKER_MINUTES`, `DFLT_MIN_DURATION_MS`, `EnvConfigError`, `InvalidTripEventError`, `MIN_AUTO_CLEANUP_MS`, `PBI_ID_MAX_LENGTH`, `TripEvent`, `TripReason`, `TripTimestamp`, `WorkerActivity`, `WorkerActivitySink`, `createCircuitBreaker`, `createWorkerActivityObserver`, `toTripEvent`, `validateWorkerActivity`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## control-checkpoint

(no header comment)

**Source:** [`agent/lib/dark-factory/control-checkpoint.ts`](../../agent/lib/dark-factory/control-checkpoint.ts)

**Exports:** `ControlUnavailableError`, `PausedRunError`, `StoppedRunError`, `createControlCheckpoint`

**Decisions:** [ADR 0007](../../docs/adr/0007-control-state-is-db-backed.md)

## control-postgres

(no header comment)

**Source:** [`agent/lib/dark-factory/control-postgres.ts`](../../agent/lib/dark-factory/control-postgres.ts)

**Exports:** `PostgresControlAdapter`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md), [ADR 0007](../../docs/adr/0007-control-state-is-db-backed.md)

## control-service

(no header comment)

**Source:** [`agent/lib/dark-factory/control-service.ts`](../../agent/lib/dark-factory/control-service.ts)

**Exports:** `ControlActionInput`, `ControlActionResult`, `performControlAction`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md), [ADR 0007](../../docs/adr/0007-control-state-is-db-backed.md)

## control

Snapshot observed by the action service; adapters compare it under lock.

**Source:** [`agent/lib/dark-factory/control.ts`](../../agent/lib/dark-factory/control.ts)

**Exports:** `ConsoleControlProvider`, `ControlAction`, `ControlChange`, `ControlConfigurationError`, `ControlEvent`, `ControlReadResult`, `ControlScope`, `ControlStore`, `ControlStoreMode`, `ControlWriteResult`, `FactoryControlState`, `InvalidControlError`, `RunControlState`, `SqliteControlAdapter`, `createControlStore`, `matchesFactorySnapshot`, `matchesRunSnapshot`, `toControlEvent`, `validateControlActor`, `validateControlReason`, `validateControlRunId`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md), [ADR 0007](../../docs/adr/0007-control-state-is-db-backed.md)

## cost-budget-query

Dark Factory — cost-budget read query (#208 R1 task 7). Pure shaping for the operator dashboard: validates the period filter, maps stored rows into a display view with a computed remaining amount, and sums totals. Operator-only and read-only; no prompts/completions are involved.

**Source:** [`agent/lib/dark-factory/cost-budget-query.ts`](../../agent/lib/dark-factory/cost-budget-query.ts)

**Exports:** `CostBudgetQueryResult`, `CostBudgetReport`, `CostBudgetTotals`, `CostBudgetView`, `queryCostBudgets`

## tenant-budget-query

Dark Factory — per-tenant budget reporting (#231, epic #212 R2). Pure shaping for the operator dashboard: turns the tenant registry plus the tenant-scoped budget rows into a per-customer view. An absent measurement stays absent (the UI renders an em dash, never 0), and an unreadable store or an unconfigured customer is kept DISTINCT from zero spend. Counts only — no prompt or completion content.

**Source:** [`agent/lib/dark-factory/tenant-budget-query.ts`](../../agent/lib/dark-factory/tenant-budget-query.ts)

**Exports:** `TenantBudgetGroup`, `TenantBudgetReport`, `TenantBudgetReportInput`, `TenantBudgetView`, `buildTenantBudgetReport`

**Decisions:** [ADR 0014](../../docs/adr/0014-tenant-budgets-are-a-dimension-of-the-store.md), [ADR 0015](../../docs/adr/0015-unprovisioned-tenant-is-refused-not-provisioned.md)

## worker-cost-client

Dark Factory — worker-side cost client (#218, epic #212 R2). The seam a Dark Factory WORKER uses to reserve a tenant cost before a long-running LLM task and reconcile it to the actual cost afterwards. A thin, opt-in client over the orchestrator governor + budget store; real wiring into the worker runtime is R3 (#215). The reservation carries the tenant, so settle lands on the tenant's own budget row; an unprovisioned tenant is refused.

**Source:** [`agent/lib/dark-factory/worker-cost-client.ts`](../../agent/lib/dark-factory/worker-cost-client.ts)

**Exports:** `WorkerCostClient`, `WorkerReserveInput`, `WorkerReserveResult`, `createWorkerCostClient`

**Decisions:** [ADR 0015](../../docs/adr/0015-unprovisioned-tenant-is-refused-not-provisioned.md)

## membership

Dark Factory — customer membership model (#215, epic #212 R3). Binds a signed-in email to a role and, for a customer, to one tenant. It is the ONLY source of tenant scope: the session cookie carries an email and nothing else, so a role or tenant change (including revocation) takes effect on the next request. Operator-managed: customers never self-provision and never edit their scope.

**Source:** [`agent/lib/dark-factory/membership.ts`](../../agent/lib/dark-factory/membership.ts)

**Exports:** `InvalidMembershipError`, `Membership`, `MembershipInput`, `MembershipRole`, `MembershipStatus`, `isMembershipActive`, `membershipScope`, `normalizeEmail`, `validateMembership`

## membership-store

Dark Factory — membership store seam (#215, epic #212 R3). Provider-neutral: `console` is fail-closed, `sqlite` is local-only (refused in production), `postgres` is required in deployed environments, plus an in-memory provider for tests. Selected by `DF_MEMBERSHIP_DRIVER`.

**Source:** [`agent/lib/dark-factory/membership-store.ts`](../../agent/lib/dark-factory/membership-store.ts)

**Exports:** `ConsoleMembershipProvider`, `InMemoryMembershipProvider`, `MembershipStore`, `MembershipStoreConfigurationError`, `MembershipStoreListResult`, `MembershipStoreMode`, `MembershipStoreReadResult`, `MembershipStoreWriteResult`, `createMembershipStore`

## membership-store-postgres

Dark Factory — PostgreSQL membership store (#215). Standard `pg` only; no vendor SDK. The schema is also shipped as `db/migrations/008_df_tenant_members.sql` with RLS enabled and no public policies; the connection stays server-side.

**Source:** [`agent/lib/dark-factory/membership-store-postgres.ts`](../../agent/lib/dark-factory/membership-store-postgres.ts)

**Exports:** `PostgresMembershipStore`

## membership-store-sqlite

Dark Factory — SQLite membership store (local/test only). Uses `node:sqlite`; the factory refuses this driver in production, so it can never become the deployed source of scope.

**Source:** [`agent/lib/dark-factory/membership-store-sqlite.ts`](../../agent/lib/dark-factory/membership-store-sqlite.ts)

**Exports:** `SqliteMembershipStore`

## cost-budget-store-postgres

Dark Factory — PostgreSQL cost budget adapter. Standard `pg` only; no vendor SDK. The reserve path takes a row lock on the budget so two concurrent calls cannot both be admitted past the cap. The schema is also shipped as a source-controlled migration (`db/migrations/001_df_cost_budgets.sql`); `ensureSchema` keeps local and integration runs working without a separate migrate step.

**Source:** [`agent/lib/dark-factory/cost-budget-store-postgres.ts`](../../agent/lib/dark-factory/cost-budget-store-postgres.ts)

**Exports:** `PostgresCostBudgetAdapter`

## cost-budget-store-sqlite

Dark Factory — SQLite cost budget adapter (local/test only). Uses `node:sqlite` with `BEGIN IMMEDIATE` so the read-check-write of a reservation is atomic against a concurrent writer. Rejected in deployed environments by the factory (see `createCostBudgetStore`).

**Source:** [`agent/lib/dark-factory/cost-budget-store-sqlite.ts`](../../agent/lib/dark-factory/cost-budget-store-sqlite.ts)

**Exports:** `SqliteCostBudgetAdapter`

## cost-budget-store

Dark Factory — provider-neutral LLM cost budget store seam. Persists per-(period, category) hard caps plus spent/reserved accumulators. The reserve -> settle model is what makes a HARD cap possible: a call's maximum estimated cost is reserved before it starts, then reconciled to the actual cost afterwards. Two backends are provided (Postgres, SQLite) plus a fail-closed `console` default and an in-memory provider for tests. Only cost/count/category/model/timestamp are stored — never prompts or completions.

**Source:** [`agent/lib/dark-factory/cost-budget-store.ts`](../../agent/lib/dark-factory/cost-budget-store.ts)

**Exports:** `ConsoleCostBudgetProvider`, `CostBudgetStore`, `CostBudgetStoreEnsureResult`, `CostBudgetStoreMode`, `CostBudgetStoreReadResult`, `CostBudgetStoreReserveResult`, `CostBudgetStoreSettleResult`, `InMemoryCostBudgetProvider`, `costBudgetId`, `createCostBudgetStore`, `isCostGovernanceConfigured`

## cost-budget

Dark Factory — canonical cost budget types, price table, and estimation. One provider-neutral cost governance contract. Token budgets are converted to USD via a model price table; the hard ceiling is always a USD amount per period. No prompts or completion content is stored here.

**Source:** [`agent/lib/dark-factory/cost-budget.ts`](../../agent/lib/dark-factory/cost-budget.ts)

**Exports:** `COST_CATEGORIES`, `CostBudget`, `CostBudgetConfigurationError`, `CostBudgetEnvError`, `CostCategory`, `DEFAULT_COST_BUDGET_PERIOD`, `ModelPrice`, `ResolvedCostBudgetEnv`, `createCostBudget`, `createCostGovernanceEnv`, `estimateCost`, `isCostBudget`, `isCostCategory`, `modelPriceTable`, `resolvePrice`, `validateCostBudgetEnv`

## cost-gate

Dark Factory — category-parameterized cost gate (#270, generalizing #217). The pre-call gate that a dynamic model resolver runs before returning a model; a refusal THROWS so the turn fails before the provider call. OPT-IN: returns `null` when cost governance is not configured.

**Source:** [`agent/lib/dark-factory/cost-gate.ts`](../../agent/lib/dark-factory/cost-gate.ts)

**Exports:** `CostGate`, `CostGateInput`, `DEFAULT_MAX_OUTPUT_TOKENS`, `createCostGate`

**Decisions:** [ADR 0020](../../docs/adr/0020-cost-governance-is-live-on-every-llm-call.md)

## cost-governor

Dark Factory — LLM cost governor. Sits between an LLM call site and the budget store. It estimates the call's maximum cost from the model price table, reserves it against the category's cap, and reconciles the actual cost afterwards. Every refusal is a structured result (never a thrown crash) so a call site can short-circuit cleanly. FAIL-CLOSED: an unconfigured cap, an unknown model price, or an unavailable store all refuse the call rather than letting it run unbounded.

**Source:** [`agent/lib/dark-factory/cost-governor.ts`](../../agent/lib/dark-factory/cost-governor.ts)

**Exports:** `CostGovernor`, `CostGovernorAdmitInput`, `CostGovernorDecision`, `CostGovernorRefusal`, `CostGovernorSettleResult`, `costBudgetId`, `createCostGovernor`, `utcMonth`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## cost-refusal-recorder

Dark Factory — record a cost refusal on a run (#270). Appends a terminal, failed run event carrying the machine-readable `CostGovernorRefusal` code, so a run stopped by the cost cap is explainable on the ticket rather than only in a log. Idempotent per (run, code, timestamp); never stores free text.

**Source:** [`agent/lib/dark-factory/cost-refusal-recorder.ts`](../../agent/lib/dark-factory/cost-refusal-recorder.ts)

**Exports:** `RecordCostRefusalInput`, `RecordCostRefusalResult`, `recordCostRefusal`

**Decisions:** [ADR 0020](../../docs/adr/0020-cost-governance-is-live-on-every-llm-call.md)

## credentials

Dark Factory — Credential ingress / worker privilege boundary (issues #141 / story #142). A BROKER, not a token dispenser: it holds the operator's token, mints opaque short-lived leases (handle + TTL + repo allow-list) and adjudicates every worker access request. The token is never handed to a sandbox — which is what makes #142 AC4 ("MUST NOT deliver a broad long-lived PAT to any worker sandbox") true by construction rather than by policy. R2 scope: this is the policy/adjudication seam. It performs NO GitHub API call itself — the concrete privileged operation that consumes the token is wired by the R3 worker. `mode: "live"` therefore means "a token is configured and leases may be issued", not "GitHub has been contacted".

**Source:** [`agent/lib/dark-factory/credentials.ts`](../../agent/lib/dark-factory/credentials.ts)

**Exports:** `AuthorizeResult`, `ConsoleCredentialBroker`, `CredentialBroker`, `CredentialEndpoint`, `CredentialEndpointRequest`, `CredentialEndpointResponse`, `InvalidGrantError`, `IssueResult`, `Lease`, `LocalBrokerOptions`, `LocalCredentialBroker`, `MAX_TTL_SECONDS`, `REPO_PAIR_PATTERN`, `RepoGrant`, `RevokeResult`, `createCredentialBroker`, `createCredentialEndpoint`, `isExpired`, `listenCredentialEndpoint`, `resolveRepoToken`, `resolveWorkerAllowedRepos`, `toRepoGrant`

**Decisions:** [ADR 0002](../../docs/adr/0002-r1-records-r2-refuses.md), [ADR 0004](../../docs/adr/0004-story-publish-is-fail-closed.md)

## definition-of-done

Dark Factory — Definition of DONE (#164). A task is done only when all of these hold: 1. A PR is opened on a task branch, linked to the issue (`Closes #<issue>`). 2. Every automated finding is dispositioned (resolved via code change, or explicitly accepted with a reasoned explanation posted on the PR). 3. The loop is bounded (`DF_MAX_REVIEW_ROUNDS`, digits-only, default 3). Recurring findings count against the budget (no reset). On exhaustion the task stops and becomes `df:blocked` / `needs-answer`. 4. The factory MUST NEVER MERGE — opening the PR is the terminal action.

**Source:** [`agent/lib/dark-factory/definition-of-done.ts`](../../agent/lib/dark-factory/definition-of-done.ts)

**Exports:** `AcTestResult`, `AcVerificationResult`, `DEFAULT_MAX_REVIEW_ROUNDS`, `DefinitionOfDoneDeps`, `DefinitionOfDoneResult`, `DefinitionOfDoneTask`, `DoneStatus`, `FindingDisposition`, `FindingDispositionStatus`, `FindingSource`, `InvalidConfigurationError`, `LabelWriter`, `PrCommentWriter`, `PrOpener`, `ReviewFinding`, `evaluateAcTraceability`, `renderAcTraceabilityTable`, `renderAcceptedFindingComment`, `resolveMaxReviewRounds`, `runDefinitionOfDone`, `type AcTraceabilityItem`

## developer-agent

Dark Factory — Developer Agent (issues #131 / story #133). A sandboxed coding agent that accepts a task description, writes code in a worker sandbox, modifies existing files guided by a skeletal map, writes unit tests, and iterates the TDD cycle until tests pass. DESIGN DECISIONS: - Fail-closed defaults: missing required fields throw InvalidTaskError - Canonical payload pattern: TaskAssignment for seam boundaries - Metrics emission: records iterations/fix-cycles via MetricsStore - Tool confinement: only git_clone, read_file, write_code, run_tests allowed - Circuit breaker integration: reads cost metrics, never bypasses them ACCEPTANCE CRITERIA COVERED: - AC1: produces code + tests from a task description - AC2: iterates until unit tests pass (bounded) - AC3: file modifications follow skeletal map guidance - AC4: only the four allowed tools are invoked - AC5: stops when tests pass and reports completed task

**Source:** [`agent/lib/dark-factory/developer-agent.ts`](../../agent/lib/dark-factory/developer-agent.ts)

**Exports:** `ALLOWED_SKELETON_EXTENSIONS`, `ALLOWED_TOOLS`, `ALLOWED_WORKSPACE_EXTENSIONS`, `CodingLoopOptions`, `CommandRunnerFn`, `DeveloperAgent`, `DeveloperAgentConfig`, `InvalidTaskError`, `IterationRecord`, `LoopContext`, `LoopResult`, `MultiFileCodingLoopOptions`, `SkeletonMap`, `SkeletonMapError`, `TaskAssignment`, `TaskAssignmentInput`, `ToolNotAllowedError`, `WorkerFn`, `WorkerResult`, `WorkerUsageSink`, `WorkspaceTools`, `applySkeletalMap`, `assertToolAllowed`, `createDeveloperAgent`, `createWorkspaceTools`, `runCodingLoop`, `runMultiFileCodingLoop`, `toTaskAssignment`, `toTaskStatus`

## diff-capture

Dark Factory — git diff capture (#295). After the developer-agent finishes editing its work tree, the diff against the base is captured, any inline `DF_*` secrets are redacted, and the sanitized diff is persisted on the run summary via `recordRunSummary`. The git invocation is injectable so the capture is unit-testable without a real repository.

**Source:** [`agent/lib/dark-factory/diff-capture.ts`](../../agent/lib/dark-factory/diff-capture.ts)

**Exports:** `CaptureWorkspaceDiffOptions`, `GitRunner`, `MAX_GIT_DIFF_CHARS`, `captureWorkspaceDiff`, `recordRunDiff`, `sanitizeDiff`
## dispatch

Dark Factory — Orchestration Core (issues #137 / story #138). The `Dispatcher`: at-most-once delivery, retry/backoff via a `RetryPolicy`, human-parking (`ParkedRunError` → `blocked`), per-run status persistence, a live control gate, and a per-invocation deadline. The pipeline it drives is sequenced by `dispatch-handler`.

**Source:** [`agent/lib/dark-factory/dispatch.ts`](../../agent/lib/dark-factory/dispatch.ts)

**Exports:** `DEFAULT_HANDLER_TIMEOUT_MS`, `DEFAULT_RETRY_POLICY`, `DispatchAttemptMetric`, `DispatchCheckpoint`, `DispatchEvent`, `DispatchHandler`, `DispatchObserver`, `DispatchOutcome`, `DispatchRecord`, `DispatchStatus`, `Dispatcher`, `DispatcherOptions`, `InvalidDispatchEventError`, `ParkedRunError`, `RetryPolicy`, `RetrySchedule`, `dedupKey`, `dispatchKey`, `nextRetry`, `toDispatchEvent`

**Decisions:** [ADR 0002](../../docs/adr/0002-r1-records-r2-refuses.md)

## dispatch-handler

Dark Factory — orchestration handler (#268). The `DispatchHandler` that runs the factory pipeline in sequence: developer → tester → pr. It owns sequence and translation only — retry/backoff, parking, status persistence, dedup, control-gating and the per-invocation deadline all live in the `Dispatcher` (see `dispatch`). A stage that returns continues; a stage that throws a plain `Error` is retryable; a stage that throws `ParkedRunError` parks the run (`blocked`, no retry). Stages are injected so the handler is unit-testable without GitHub, an LLM, or the network.

**Source:** [`agent/lib/dark-factory/dispatch-handler.ts`](../../agent/lib/dark-factory/dispatch-handler.ts)

**Exports:** `DispatchHandlerDeps`, `FactoryStageContext`, `FactoryStages`, `TesterStageResult`, `createDispatchHandler`

**Decisions:** [ADR 0019](../../docs/adr/0019-orchestration-handler-pipeline.md)

## dod-presentation

Dark Factory — Definition of Done Markdown Presentation Layer (#179). Formats AC traceability matrices and accepted review finding comments for GitHub PR discussions. Keeps domain verification decoupled from markdown rendering.

**Source:** [`agent/lib/dark-factory/dod-presentation.ts`](../../agent/lib/dark-factory/dod-presentation.ts)

**Exports:** `AcTraceabilityItem`, `renderAcTraceabilityTable`, `renderAcceptedFindingComment`

## entry

Dark Factory — the entry point (#163). WHAT IT DOES: takes the trigger's decision, records the dispatch durably (which is what makes a repeat label idempotent and the run abortable), moves the lifecycle labels, and hands the work off. WHAT IT DELIBERATELY DOES NOT DO: **run the factory loop**. There is no queue and no cron in this repository (`vercel.json` is framework-only), so the only out-of-band mechanism that exists — and the one the story and sprint triggers already use — is a POST to Eve's own session API. Calling the worker handler inline would run the loop inside a serverless request, which the ACs forbid; the handler is therefore never invoked here, and `EntryDeps.handler` exists only so a test can prove that. LOCAL MODE follows `requiresSignature()`'s hard-won rule in the webhook route: the gate must not be keyed on a platform variable alone, and **the absence of configuration must never be read as permission to relax the control**. So local runs are opt-IN and refused for ANY production build — Vercel's or a self-hosted one.

**Source:** [`agent/lib/dark-factory/entry.ts`](../../agent/lib/dark-factory/entry.ts)

**Exports:** `DispatchIntent`, `EntryDeps`, `EntryResult`, `EntryStatus`, `LabelWriter`, `RunnerDecision`, `RunnerMode`, `buildIntent`, `renderHandoffMessage`, `resolveApiOrigin`, `resolveRunnerMode`, `runDarkFactoryDispatch`, `sanitizeIdentifier`, `toRunId`

## governed-agent-call

Dark Factory — a governed agent LLM call (#270). Wraps `runGovernedLlmCall` for an AGENT call site (the runner's Architect / Developer calls); on a refusal it records the code ON THE RUN and throws `CostRefusedError`. OPT-IN: with no governor the call runs unchanged.

**Source:** [`agent/lib/dark-factory/governed-agent-call.ts`](../../agent/lib/dark-factory/governed-agent-call.ts)

**Exports:** `CostRefusedError`, `GovernedAgentCallDeps`, `GovernedAgentCallOptions`, `runGovernedAgentCall`

**Decisions:** [ADR 0020](../../docs/adr/0020-cost-governance-is-live-on-every-llm-call.md)

## governed-llm-call

Dark Factory — governed LLM call seam. The single wrapper every LLM call site uses to be budget-governed: reserve the call's maximum cost, run it, then reconcile the actual cost. A refusal is returned (not thrown) so a call site can short-circuit; a thrown call still settles conservatively so a reservation is never leaked.

**Source:** [`agent/lib/dark-factory/governed-llm-call.ts`](../../agent/lib/dark-factory/governed-llm-call.ts)

**Exports:** `GovernedLlmCallOptions`, `GovernedLlmCallResult`, `runGovernedLlmCall`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## governed-model

Dark Factory — governed dynamic model (#270). The category-parameterized `defineDynamic` resolver shared by the subagents: it runs a cost gate FIRST, so a refusal fails the turn before the provider call. OPT-IN: with no gate the static model is used. A dynamic model forbids `modelContextWindowTokens` as a sibling, so a definition selects one branch or the other.

**Source:** [`agent/lib/dark-factory/governed-model.ts`](../../agent/lib/dark-factory/governed-model.ts)

**Exports:** `GovernedGate`, `GovernedModelInput`, `buildGovernedDynamicModel`

**Decisions:** [ADR 0020](../../docs/adr/0020-cost-governance-is-live-on-every-llm-call.md)

## index

Dark Factory — wiring hub (R1: #134, #138, #140 · R2: #135, #142). Single place where the seam adapters are chosen from the environment, so the orchestrator never imports a concrete adapter directly. Every factory is fail-closed: an unset driver yields the refusing default rather than a silently non-persistent in-process store — and, for R2, an unset token yields a broker that refuses to issue a lease, and an unset provider yields an honest dry-run that never claims isolation.

**Source:** [`agent/lib/dark-factory/index.ts`](../../agent/lib/dark-factory/index.ts)

**Exports:** `ALLOWED_ENV_KEYS`, `ALLOWED_SKELETON_EXTENSIONS`, `ALLOWED_TOOLS`, `BenchmarkMeasurer`, `CADENCE_WATERMARK_KEY`, `CircuitBreaker`, `ConsoleReporter`, `ConsoleRunHistoryStore`, `DEFAULT_INTERVAL_MINUTES`, `DEFAULT_ITERATION_STEP`, `DEFAULT_MAX_REVIEW_ROUNDS`, `DEFAULT_TARGET_SUCCESS_RATE`, `DeveloperAgent`, `GitHubCommentReporter`, `GitHubIssueWriter`, `GitHubPrWriter`, `InMemoryImprovementLedger`, `InvalidConfigurationError`, `InvalidProposalError`, `InvalidRunRecordError`, `InvalidTaskError`, `InvalidWorkerMessageError`, `IterationBoundSurface`, `MAX_ATTEMPT`, `MAX_BENCHMARK_EFFORT`, `MAX_BRIEF_BODY_CHARS`, `MAX_BRIEF_TITLE_CHARS`, `MAX_QUESTION_CHARS`, `MAX_REASON_CHARS`, `MAX_TEST_EVIDENCE_CHARS`, `MAX_TEST_EVIDENCE_LINES`, `OPERATOR_DECISIONS_KEY`, `ParkedRunError`, `PlatformConfigurationError`, `RunHistoryConfigurationError`, `SKILLS`, `SKILL_NAMES`, `SelfImprovementConfigError`, `SelfImprovementStateError`, `SkeletonMapError`, `SkillCatalogueError`, `SqliteRunHistoryStore`, `SupersededVersionError`, `TRIGGER_DEFAULTS`, `TRIGGER_LABELS`, `TesterAgent`, `ToolNotAllowedError`, `ValidationError`, `ValidationFailedError`, `applyRunEvent`, `applySkeletalMap`, `assertToolAllowed`, `buildIntent`, `canonicaliseSkills`, `createCadenceWatermark`, `createCircuitBreaker`, `createCredentialBroker`, `createDeveloperAgent`, `createDispatchObserver`, `createMetricsStore`, `createOperatorDecisionStore`, `createPlatformAdapter`, `createRetryPolicy`, `createRunHistoryStore`, `createSelfImprovementController`, `createSkillSetSurface`, `createStateStore`, `createTesterAgent`, `createValidationReport`, `createWorkerActivityObserver`, `createWorkerHandler`, `createWorkerProvider`, `createWorkerReporter`, `decide`, `decideDarkFactoryTrigger`, `defaultCommandRunner`, `isCycleDue`, `loadImprovementBenchmark`, `makeProposal`, `measureBenchmark`, `nextRunAt`, `objectiveTrend`, `observeTaskType`, `operatorGateFromStore`, `parseSkillName`, `proposeFromObservation`, `proposeSkillAddition`, `renderAcceptedFindingComment`, `renderHandoffMessage`, `renderMessage`, `reporterKey`, `resolveCapabilities`, `resolveIssueToken`, `resolveMaxReviewRounds`, `resolveRunnerMode`, `resolveSelfImprovementEnvConfig`, `resolveStateDbPath`, `resolveTriggerAllowedUsers`, `resolveTriggerLabel`, `runCodingLoop`, `runDarkFactoryDispatch`, `runDefinitionOfDone`, `runScheduledCycle`, `sanitizeIdentifier`, `summarizeRecords`, `toRunEvent`, `toRunId`, `toRunSummary`, `toTaskAssignment`, `toTaskStatus`, `toWorkerMessage`, `type CadenceInput`, `type CadenceWatermark`, `type Capabilities`, `type CircuitBreakerConfig`, `type CodingLoopOptions`, `type CommandRunner`, `type CostGuard`, `type CreatePullRequestOptions`, `type CreatePullRequestResult`, `type CycleResult`, `type DarkFactoryTriggerDecision`, `type DarkFactoryTriggerKind`, `type DarkFactoryTriggerPayload`, `type Decision`, `type DecisionConfig`, `type DefinitionOfDoneDeps`, `type DefinitionOfDoneResult`, `type DefinitionOfDoneTask`, `type DeploymentStage`, `type DeveloperAgentConfig`, `type DispatchIntent`, `type DoneStatus`, `type EntryDeps`, `type EntryResult`, `type EntryStatus`, `type FindingDisposition`, `type FindingDispositionStatus`, `type FindingSource`, `type GitHubPrWriterOptions`, `type ImprovementBenchmark`, `type ImprovementLedger`, `type IssueWriterFetch`, `type IterationRecord`, `type LabelWriter`, `type LedgerEntry`, `type LoopContext`, `type LoopResult`, `type Measurement`, `type Measurer`, `type ObjectiveTrend`, `type Observation`, `type Observer`, `type OperatorDecision`, `type OperatorDecisionStore`, `type OperatorDecisionValue`, `type OperatorGate`, `type PassFail`, `type PlatformAdapter`, `type PlatformContext`, `type PlatformProviderId`, `type Proposal`, `type Proposer`, `type PullRequestDetails`, `type ReportResult`, `type ReviewFinding`, `type RunEvent`, `type RunEventType`, `type RunStage`, `type RunStatus`, `type RunSummary`, `type RunnerDecision`, `type RunnerMode`, `type ScheduledRunOptions`, `type ScheduledRunResult`, `type SecurityAlert`, `type SelfImprovementConfig`, `type SelfImprovementController`, `type SelfImprovementDeps`, `type SelfImprovementEnvConfig`, `type SkeletonMap`, `type SkillDefinition`, `type SkillEvidence`, `type SkillGrant`, `type SkillName`, `type SkillSet`, `type SkillSetSurface`, `type TaskAssignment`, `type TrendPoint`, `type TripEvent`, `type TripReason`, `type TunableSurface`, `type ValidationReport`, `type ValidationRequest`, `type VersionHandle`, `type WorkerActivity`, `type WorkerActivitySink`, `type WorkerMessage`, `type WorkerMessageKind`, `type WorkerReporter`, `type WorkerResult`, `type WriteResult`, `validateCatalogue`, `validateWorkerActivity`

## issue-writer

Dark Factory — the GitHub primitives the orchestrator needs to speak on a ticket: post a comment, edit a comment, add a label, remove a label (#162). Why these live here rather than being called from the story provider: `backlog-provider.ts`'s `GitHubProvider` already does all four inline, but `BacklogProvider` exposes only `publish(payload)`. Refactoring merged, fail-closed story-publish code is not this issue's business, so the reporter gets its own small, token-injected set of primitives — and `backlog-provider` can adopt them later. Two behaviours are copied deliberately from `GitHubProvider` rather than rediscovered: - the token is resolved and used HERE, in the orchestrator's process; it is never passed to a worker task (#142); - removing a label that is already absent (404) is SUCCESS, not a warning, so a retry cannot pile up spurious errors.

**Source:** [`agent/lib/dark-factory/issue-writer.ts`](../../agent/lib/dark-factory/issue-writer.ts)

**Exports:** `GitHubIssueWriter`, `GitHubIssueWriterOptions`, `IssueWriterFetch`, `WriteResult`, `createGitHubLabelWriter`, `resolveIssueToken`

**Decisions:** [ADR 0004](../../docs/adr/0004-story-publish-is-fail-closed.md)

## llm-policy-adapter

Dark Factory — LLM policy provider adapter (#208, epic #206 R7.2). Maps the canonical `LlmPolicy` onto provider request parameters. The policy itself carries no vendor fields, so a provider change means a new adapter, not a change to `LlmPolicy`. Degradation is REPORTED, never silent: a model that cannot reason receives no reasoning parameters and the result says so, so the dashboard can show the no-op rather than implying the level took effect.

**Source:** [`agent/lib/dark-factory/llm-policy-adapter.ts`](../../agent/lib/dark-factory/llm-policy-adapter.ts)

**Exports:** `AppliedPolicy`, `applyThinkingPolicy`, `supportsReasoning`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## llm-policy-query

Dark Factory — effective LLM policy report (#208, epic #206 R7.2). Pure shaping for the operator dashboard: resolves the canonical policy and reports, per LLM surface, the model that will be used and whether the thinking level actually reached the provider. Read-only, and never returns a secret — the policy carries no credentials, and the surface models are ids, not keys.

**Source:** [`agent/lib/dark-factory/llm-policy-query.ts`](../../agent/lib/dark-factory/llm-policy-query.ts)

**Exports:** `LlmPolicyReport`, `LlmPolicySurfaceInput`, `LlmPolicySurfaceName`, `LlmPolicySurfaceView`, `buildLlmPolicyReport`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## llm-policy

Dark Factory — canonical LLM call policy (#208, epic #206 R7.2). ONE provider-neutral description of how LLM calls should behave: how hard the model should think, and how many steps it may take. Policy is ENV-driven and a deploy-time setting — deliberately not DB-backed, unlike the R7.1 off-switch, which is dynamic by nature. Resolution is FAIL-CLOSED: an unset value uses the documented default, but a malformed or out-of-range value THROWS. A silent default is the exact failure mode this module exists to remove — an operator who types `highish` must be told, not quietly given `medium`.

**Source:** [`agent/lib/dark-factory/llm-policy.ts`](../../agent/lib/dark-factory/llm-policy.ts)

**Exports:** `DEFAULT_MAX_STEPS`, `DEFAULT_THINKING_LEVEL`, `EnvConfigError`, `LlmPolicy`, `MAX_POLICY_STEPS`, `POLICY_MAX_STEPS_VAR`, `POLICY_MODEL_VAR`, `POLICY_THINKING_LEVEL_VAR`, `THINKING_LEVELS`, `ThinkingLevel`, `isLlmPolicyConfigured`, `resolveLlmPolicy`, `resolvePolicyMaxSteps`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## metrics

Dark Factory — Observability / Self-Improvement (issues #139 / story #140). The sensor: a canonical, provider-agnostic metric record per completed task, a store seam, and a no-loss retry decorator. This module is a pure PRODUCER of metrics. It imports no consumer and must not: naming or depending on a reader here would invert the dependency.

**Source:** [`agent/lib/dark-factory/metrics.ts`](../../agent/lib/dark-factory/metrics.ts)

**Exports:** `BufferedMetricsRecorder`, `FixEvent`, `InMemoryMetricsStore`, `InvalidMetricsError`, `MAX_METRIC_COST_USD`, `MAX_METRIC_LATENCY_MS`, `MetricsStore`, `MetricsWriteResult`, `TaskMetric`, `TaskMetricInput`, `TaskStatus`, `countFixCycles`, `createMetricsStore`, `meanOfMeasured`, `round2`, `toTaskMetric`

**Decisions:** [ADR 0003](../../docs/adr/0003-unmeasured-is-never-zero.md)

## operator-cli

Operator CLI for the self-improvement gate (#159). The gate in `self-improve.ts` blocks every `access-widening` proposal until a decision is recorded ("blocked: operator gate missing"), and NOTHING in the application records one: `createOperatorDecisionStore` is re-exported but never called outside its test. This module is therefore the only way the gate can be satisfied, which is why every rule below is fail-closed. Deliberately PURE: it takes an injected decision store and clock and returns `{ lines, exitCode }`. No `process`, no `console`, no filesystem — so the behaviour is provable in tests and identical wherever it is invoked.

**Source:** [`agent/lib/dark-factory/operator-cli.ts`](../../agent/lib/dark-factory/operator-cli.ts)

**Exports:** `OPERATOR_CLI_USAGE`, `OperatorCliCommand`, `OperatorCliDeps`, `OperatorCliResult`, `OperatorCliUsageError`, `OperatorDecisionValue`, `ProposalKind`, `parseOperatorArgs`, `runOperatorCli`

## plan-validator

Dark Factory — Execution Plan Domain Validator (#179). Pre-flight validation gate that evaluates an ExecutionPlan produced by the Architect Agent before code generation begins. Ensures plans touch appropriate repository domains (e.g. UI/Chat stories modify UI entrypoints) and that every Acceptance Criterion from the User Story is mapped to an automated test case.

**Source:** [`agent/lib/dark-factory/plan-validator.ts`](../../agent/lib/dark-factory/plan-validator.ts)

**Exports:** `AcceptanceCriteriaTestMapping`, `DefaultPlanParser`, `ExecutionPlan`, `PlanParser`, `PlanTargetFile`, `PlanValidationResult`, `extractStoryAcceptanceCriteria`, `safeJsonParse`, `validateExecutionPlan`

## platform-auth

Select the optional platform authenticator while preserving common auth order. The Vercel authenticator factory is lazy so a generic deployment neither constructs nor depends on Vercel OIDC behavior.

**Source:** [`agent/lib/dark-factory/platform-auth.ts`](../../agent/lib/dark-factory/platform-auth.ts)

**Exports:** `selectPlatformAuth`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## platform

Platform-specific runtime facts consumed by Dark Factory. Provider-specific environment variables are read only in these adapters. The orchestration consumes the normalized context and never needs to know how a host names its deployment stage or URL.

**Source:** [`agent/lib/dark-factory/platform.ts`](../../agent/lib/dark-factory/platform.ts)

**Exports:** `DeploymentStage`, `PlatformAdapter`, `PlatformConfigurationError`, `PlatformContext`, `PlatformProviderId`, `createPlatformAdapter`

## pr-writer

Dark Factory — PR Writer (#164). Provides the GitHub pull request creation primitive for the orchestrator. CRITICAL INVARIANTS: 1. Opening a PR is the terminal automated action. 2. Merging is STRICTLY forbidden for the factory — this module does NOT implement, expose, or call any merge endpoints. 3. Fail-closed: repository MUST be in DF_WORKER_ALLOWED_REPOS. 4. Injected fetchImpl for offline/deterministic testing without network calls.

**Source:** [`agent/lib/dark-factory/pr-writer.ts`](../../agent/lib/dark-factory/pr-writer.ts)

**Exports:** `CreatePullRequestOptions`, `CreatePullRequestResult`, `GitHubPrWriter`, `GitHubPrWriterOptions`, `PullRequestDetails`

**Decisions:** [ADR 0004](../../docs/adr/0004-story-publish-is-fail-closed.md)

## run-attribution

Resolve the tenant a newly accepted run is attributed to (#213, epic #212 R1). Resolution is TOTAL, and that is the point: an unconfigured registry, an unassigned repository, a registry outage, or a store that throws all degrade to UNASSIGNED (undefined) rather than failing. R1 only RECORDS attribution — refusing to accept a run because it cannot be attributed would break existing operator flows before the repository seed has been applied everywhere. The refusal half of the contract belongs to R2, and is enforced there. An INACTIVE tenant still attributes. The run genuinely belongs to them, and historical attribution must not be rewritten when they are re-activated.

**Source:** [`agent/lib/dark-factory/run-attribution.ts`](../../agent/lib/dark-factory/run-attribution.ts)

**Exports:** `resolveRunTenant`

**Decisions:** [ADR 0001](../../docs/adr/0001-tenant-attribution-is-write-once.md)

## run-history-postgres

(no header comment)

**Source:** [`agent/lib/dark-factory/run-history-postgres.ts`](../../agent/lib/dark-factory/run-history-postgres.ts)

**Exports:** `PostgresRunHistoryStore`

**Decisions:** [ADR 0003](../../docs/adr/0003-unmeasured-is-never-zero.md), [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## run-history-provider

(no header comment)

**Source:** [`agent/lib/dark-factory/run-history-provider.ts`](../../agent/lib/dark-factory/run-history-provider.ts)

**Exports:** `ConsoleRunHistoryStore`, `RunHistoryConfigurationError`, `createRunHistoryStore`

**Decisions:** [ADR 0003](../../docs/adr/0003-unmeasured-is-never-zero.md), [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## run-history-store

Customer tenant this run is attributed to. Absent means UNASSIGNED — a legitimate state for historical runs recorded before attribution existed. Resolved ONCE at acceptance; never re-derived, so reassigning the repository cannot rewrite a run's stored attribution.

**Source:** [`agent/lib/dark-factory/run-history-store.ts`](../../agent/lib/dark-factory/run-history-store.ts)

**Exports:** `AcceptRunDelivery`, `AdvanceRunControlDelivery`, `ClaimRunControlDelivery`, `EventCursor`, `Page`, `PersistedRunEvent`, `RunControlDeliveryReceipt`, `RunControlTransition`, `RunCursor`, `RunEventListOptions`, `RunHistoryReadResult`, `RunHistoryStore`, `RunHistoryWriteResult`, `RunListOptions`, `SqliteRunHistoryStore`

**Decisions:** [ADR 0003](../../docs/adr/0003-unmeasured-is-never-zero.md), [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## run-history

One current, provider-neutral projection for a single execution.

**Source:** [`agent/lib/dark-factory/run-history.ts`](../../agent/lib/dark-factory/run-history.ts)

**Exports:** `ALL_RUN_STATUSES`, `InvalidRunRecordError`, `RunEvent`, `RunEventType`, `RunMeasuredSummary`, `RunMetrics`, `RunMetricsQuery`, `RunStage`, `RunStatus`, `RunStatusCount`, `RunSummary`, `RunTrendPoint`, `TERMINAL_RUN_STATUSES`, `applyRunEvent`, `normalizeRunDateRange`, `toRunEvent`, `toRunSummary`

**Decisions:** [ADR 0003](../../docs/adr/0003-unmeasured-is-never-zero.md)

## run-query

Opaque, URL-safe pagination cursor codec. The public API never exposes the store's internal cursor shape (createdAt + runId, or sequence), so a host change cannot leak storage-specific identifiers and a tampered cursor fails closed to a 400 rather than being trusted.

**Source:** [`agent/lib/dark-factory/run-query.ts`](../../agent/lib/dark-factory/run-query.ts)

**Exports:** `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `RunDetailOutcome`, `RunEventParams`, `RunEventRequest`, `RunListOutcome`, `RunListParams`, `RunListRequest`, `RunMetricsOutcome`, `RunMetricsParams`, `RunMetricsRequest`, `ValidationResult`, `decodeEventCursor`, `decodeListCursor`, `encodeEventCursor`, `encodeListCursor`, `queryRunDetail`, `queryRunDetailFromParams`, `queryRunList`, `queryRunListFromParams`, `queryRunMetrics`, `queryRunMetricsFromParams`, `validateRunEventParams`, `validateRunListParams`, `validateRunMetricsParams`

**Decisions:** [ADR 0003](../../docs/adr/0003-unmeasured-is-never-zero.md)

## self-improve-state

Dark Factory — self-improvement PERSISTENCE adapters (#146, R4b). `self-improve.ts` deliberately imports no store: the controller is storage-agnostic, and this module is the one place that binds the loop to the existing `StateStore` seam (#134). Two things need durability: - the CADENCE WATERMARK — when a cycle last ran, so the caller's scheduler can ask "is a cycle due?" without a long-lived timer. - OPERATOR DECISIONS — a pre-armed human allow/deny for a (surface, kind) pair, which `operatorGateFromStore` turns into the `OperatorGate` the controller already consumes. Both use a single key holding a JSON value, because `StateStore` exposes only `save(key, value)` / `get(key)` — there is no key enumeration, so a list of decisions is stored as an array and upserted in place.

**Source:** [`agent/lib/dark-factory/self-improve-state.ts`](../../agent/lib/dark-factory/self-improve-state.ts)

**Exports:** `CADENCE_WATERMARK_KEY`, `OPERATOR_DECISIONS_KEY`, `OperatorDecision`, `OperatorDecisionStore`, `OperatorDecisionValue`, `SelfImprovementStateError`, `createCadenceWatermark`, `createOperatorDecisionStore`, `operatorGateFromStore`

## self-improve

Dark Factory — Measurable Recursive Self-Improvement (#146, R4a). One bounded, FAIL-CLOSED cycle: OBSERVE → read the aggregate metrics from #140 (never a parallel store) PROPOSE → a candidate change to a tunable surface + a written hypothesis APPLY → staged behind a versioned, reversible handle (never in place) MEASURE → re-run a fixed, deterministic benchmark set DECIDE → accept iff the objective improves and no guardrail regresses RECORD → append an immutable ledger entry {what, why, before → after, verdict} Every step is an injected interface, so no model, vendor or tool is named here. Reversibility and fail-closed verification are the whole point: an unverified self-improvement loop will happily improve itself into a regression. R4b adds the recurrence (cadence + trend report + operator CLI). SCAFFOLD: signatures are declared with real types so the test file collects; behaviour is implemented RED → GREEN per the plan's cycle table.

**Source:** [`agent/lib/dark-factory/self-improve.ts`](../../agent/lib/dark-factory/self-improve.ts)

**Exports:** `BenchmarkCase`, `BenchmarkMeasurer`, `CadenceInput`, `CadenceWatermark`, `CostGuard`, `CycleResult`, `DEFAULT_INTERVAL_MINUTES`, `DEFAULT_ITERATION_STEP`, `DEFAULT_TARGET_SUCCESS_RATE`, `Decision`, `DecisionConfig`, `ImprovementBenchmark`, `ImprovementLedger`, `InMemoryImprovementLedger`, `InvalidProposalError`, `IterationBoundSurface`, `LedgerEntry`, `MAX_BENCHMARK_EFFORT`, `Measurement`, `Measurer`, `ObjectiveTrend`, `Observation`, `Observer`, `OperatorGate`, `Proposal`, `ProposeOptions`, `Proposer`, `ScheduledRunOptions`, `ScheduledRunResult`, `SelfImprovementConfig`, `SelfImprovementConfigError`, `SelfImprovementController`, `SelfImprovementDeps`, `SelfImprovementEnvConfig`, `SupersededVersionError`, `TrendPoint`, `TunableSurface`, `VersionHandle`, `createSelfImprovementController`, `decide`, `isCycleDue`, `loadImprovementBenchmark`, `makeProposal`, `measureBenchmark`, `nextRunAt`, `objectiveTrend`, `observeTaskType`, `proposeFromObservation`, `resolveSelfImprovementEnvConfig`, `runImprovementCycle`, `runScheduledCycle`, `summarizeRecords`

## skill-set-surface

Dark Factory — the skill-set tunable surface (#157). The concrete surface that #146 AC8 only *seamed*: a real `TunableSurface` whose value is the set of enabled skills, persisted through the `StateStore` so that a restart does not forget it. Two constraints come straight from the interfaces it must satisfy: - `TunableSurface.read()` is **synchronous**, so the store cannot be read on every call: `createSkillSetSurface` loads the snapshot once (async) and caches it. That is why this is a factory rather than a constructor. - `VersionHandle` requires `previous`/`next` and an **idempotent** `revert()`, plus the superseded-handle guard `IterationBoundSurface` established: a stale handle must not be able to silently undo a newer change. Widening capability is the gated class: adding a skill is `access-widening`, so the controller cannot apply it without an armed operator decision (#159's CLI is how one is armed).

**Source:** [`agent/lib/dark-factory/skill-set-surface.ts`](../../agent/lib/dark-factory/skill-set-surface.ts)

**Exports:** `SkillEvidence`, `SkillSet`, `SkillSetSurface`, `createSkillSetSurface`, `proposeSkillAddition`

## skills

Dark Factory — skill catalogue (#157). A skill is a **capability grant**: a named capability defined by the permission delta it grants. This is the vocabulary that the skill-set surface (`skill-set-surface.ts`) tunes, and that the operator gate guards. SCOPE, decided by REVIEW rather than assumed: `ALLOWED_TOOLS` is the only tool vocabulary in this repository — a grep for tool-like names across `agent/lib/dark-factory/` returns exactly its four members — and the worker protocol takes a free-form command string, so there is **no registry a skill could add a tool to**. A skill that claimed to grant a new tool would be inventing capability that does not exist, so this catalogue does not offer that. What genuinely widens capability today is the **file-extension allow-list**: `.sql`, `.sh`, `.graphql` and `.prisma` are refused by `applySkeletalMap`. A skill granting one of those is a real, visible widening — and the refusal path that proves it is already tested. `tools` is kept in the grant shape for the day a registry exists, and a grant naming a tool this repo cannot honour is refused at catalogue load.

**Source:** [`agent/lib/dark-factory/skills.ts`](../../agent/lib/dark-factory/skills.ts)

**Exports:** `Capabilities`, `SKILLS`, `SKILL_NAMES`, `SkillCatalogueError`, `SkillDefinition`, `SkillGrant`, `SkillName`, `canonicaliseSkills`, `parseSkillName`, `resolveCapabilities`, `validateCatalogue`

## state-provider

Decide containment with the platform's own path comparison. `path.relative` is used rather than `startsWith(root + sep)` because relative() follows the host's case sensitivity (Node's win32 implementation compares case-insensitively, matching a case-insensitive filesystem, while POSIX stays case-sensitive). A raw prefix compare false-rejected a legitimate path whose drive letter differed in case ('c:\\x' vs 'C:\\x').

**Source:** [`agent/lib/dark-factory/state-provider.ts`](../../agent/lib/dark-factory/state-provider.ts)

**Exports:** `createStateStore`, `resolveStateDbPath`

**Decisions:** [ADR 0002](../../docs/adr/0002-r1-records-r2-refuses.md), [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## state

Dark Factory — Stateful Execution Memory (issue #134). A `dark factory` must remember what issue it is working on, which worker it assigned, the outcome of the last test run, and where it is in the multi-step delivery loop. Eve is stateless between requests, so that memory lives in an external store reached through this seam. Mirrors the established provider seam in `agent/lib/backlog-provider.ts`: a canonical, provider-agnostic payload (`ExecutionContext`) plus a provider interface (`StateStore`) with concrete adapters. The default is a fail-closed `console` provider that refuses to pretend it persisted anything.

**Source:** [`agent/lib/dark-factory/state.ts`](../../agent/lib/dark-factory/state.ts)

**Exports:** `ConsoleStateProvider`, `ExecutionContext`, `InvalidExecutionContextError`, `SqliteStateAdapter`, `StateReadResult`, `StateStore`, `StateStoreMode`, `StateWriteResult`, `deliveryKey`, `loadContext`, `saveContext`, `toExecutionContext`

**Decisions:** [ADR 0002](../../docs/adr/0002-r1-records-r2-refuses.md), [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## tenant-store-postgres

Dark Factory — PostgreSQL tenant registry adapter (#213, epic #212 R1). Standard `pg` only; no vendor SDK. The same contract as the in-memory and SQLite adapters, so callers never learn which backend is configured. Validation happens OUTSIDE the wrapped driver call, so a malformed id or slug still throws while a genuine database failure becomes `{ ok: false }`.

**Source:** [`agent/lib/dark-factory/tenant-store-postgres.ts`](../../agent/lib/dark-factory/tenant-store-postgres.ts)

**Exports:** `PostgresTenantStore`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md), [ADR 0008](../../docs/adr/0008-tenant-registry-is-ours-crm-is-bought.md)

## tenant-store-provider

Dark Factory — tenant registry driver factory (#213, epic #212 R1). The registry is OPT-IN: with no driver set the in-memory adapter is used, which writes nowhere external. An explicit `postgres` or `sqlite` driver is required before anything leaves the process, so enabling tenant attribution cannot break an existing deployment. The `isDeployedRuntime` rule is repeated here rather than shared: the same three-line predicate is private in `run-history-provider.ts` and inlined in `control.ts` / `cost-budget-store.ts` / `usage-store-provider.ts`. Consolidating all of them is a cross-module refactor, deliberately out of scope for this issue.

**Source:** [`agent/lib/dark-factory/tenant-store-provider.ts`](../../agent/lib/dark-factory/tenant-store-provider.ts)

**Exports:** `TenantConfigurationError`, `createTenantStore`, `isTenantRegistryConfigured`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md), [ADR 0008](../../docs/adr/0008-tenant-registry-is-ours-crm-is-bought.md)

## tenant-store-sqlite

Dark Factory — local SQLite tenant registry (#213, epic #212 R1). File-backed adapter for local development and contract testing. Local-only: the driver factory refuses it in a deployed runtime. Validation happens OUTSIDE the wrapped driver call, so a malformed id or slug still throws while a genuine database failure becomes `{ ok: false }`.

**Source:** [`agent/lib/dark-factory/tenant-store-sqlite.ts`](../../agent/lib/dark-factory/tenant-store-sqlite.ts)

**Exports:** `SqliteTenantStore`, `SqliteTenantStoreOptions`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md), [ADR 0008](../../docs/adr/0008-tenant-registry-is-ours-crm-is-bought.md)

## tenant-store

Dark Factory — tenant store seam (#213, epic #212 R1). The contract every backend (in-memory, SQLite, Postgres) must satisfy, so the rest of the system never learns which one is configured. Two error shapes, deliberately distinct: - **Invalid input** (a malformed id, slug, name, or repo) throws `InvalidTenantError`. That is a programmer or configuration defect, and it should be loud. - **A handled-but-unsuccessful call** (unknown tenant, inactive tenant, a driver outage) returns `{ ok: false, error }`. A real driver can also REJECT, so every call is wrapped and converted to this same shape — otherwise a store outage surfaces as a rejected promise that terminates the caller. "Not found" is NOT an error: `getTenant` returns `{ ok: true, value: null }`, so "no such tenant" stays distinct from "cannot read the store".

**Source:** [`agent/lib/dark-factory/tenant-store.ts`](../../agent/lib/dark-factory/tenant-store.ts)

**Exports:** `InMemoryTenantStore`, `RepoAssignment`, `RepoResolution`, `TenantStore`, `TenantStoreResult`, `UpsertTenantInput`, `validateTenantName`, `validateTenantStatus`, `withTenantStoreResult`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md), [ADR 0008](../../docs/adr/0008-tenant-registry-is-ours-crm-is-bought.md)

## tenant-usage-query

Dark Factory — tenant usage report (#213, epic #212 R1). Operator-only, read-only aggregation of measured usage and cost BY TENANT over a time window. Counts only — no prompt or completion text. Two invariants carry the whole report: - Unattributed usage lands in its OWN `unassigned` bucket. It is never folded into a customer's total, because unattributed spend is not any customer's spend. - An unmeasured value stays ABSENT, so the UI renders `—` rather than `0`. A `0` asserts we measured zero, which is a different and false claim. A malformed window is a CALLER error (400), deliberately distinguished from an unavailable ledger (503): conflating the two sends an operator hunting for a database outage when they simply typed a bad date.

**Source:** [`agent/lib/dark-factory/tenant-usage-query.ts`](../../agent/lib/dark-factory/tenant-usage-query.ts)

**Exports:** `TenantUsageParams`, `TenantUsageQueryResult`, `TenantUsageReport`, `queryTenantUsage`

**Decisions:** [ADR 0008](../../docs/adr/0008-tenant-registry-is-ours-crm-is-bought.md)

## tenant

Dark Factory — canonical customer tenant model (#213, epic #212 R1). A tenant is a customer whose Dark Factory activity and measured LLM spend we attribute. The id is OPAQUE and STABLE: it is never the slug and never a repository name, so renaming either cannot break attribution. This module is the intake seam for untrusted identifiers. Repository slugs arrive from webhooks, so they are validated and normalised HERE, before they reach any canonical payload, log line, or dry-run provider.

**Source:** [`agent/lib/dark-factory/tenant.ts`](../../agent/lib/dark-factory/tenant.ts)

**Exports:** `InvalidTenantError`, `REPO_SLUG_MAX_LENGTH`, `TENANT_SLUG_MAX_LENGTH`, `Tenant`, `TenantStatus`, `isTenantActive`, `newTenantId`, `normalizeRepoSlug`, `validateTenantId`, `validateTenantSlug`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md), [ADR 0008](../../docs/adr/0008-tenant-registry-is-ours-crm-is-bought.md)

## tester-agent

Dark Factory — Tester Agent (issues #132 / story #136). A pre-PR validation gate that runs static analysis, smoke tests, and security scans to catch quality and security regressions before merge. DESIGN DECISIONS: - Fail-closed defaults: missing config = no validation, failed check = block PR - Canonical payload pattern: ValidationRequest/ValidationReport for seams - Metrics emission: reports pass/fail via MetricsStore for observability - Dependency injection: CommandRunner interface for testability - Command whitelist: only allow npx commands (tsc, cspell, vitest, gitleaks) REQUIRED DEPENDENCIES: - `tsc` (TypeScript compiler, via npx) for static analysis - `cspell` (spell checker, via npx) for documentation quality - `vitest` (test runner, via npx) for smoke tests - `gitleaks` (secret scanner, via npx) for security scan (optional) EXPECTED PROJECT STRUCTURE: - agent/lib/dark-factory/*.ts — source under test - tests/dark-factory/*.test.ts — corresponding test files ENVIRONMENT VARIABLES (read by createTesterAgent): - DF_SECURITY_SCAN_ENABLED: "true" to enable gitleaks scan (default: false) - DF_TESTER_TIMEOUT_MS: per-check timeout in ms (default: 60000) - DF_SECURITY_TOOLS: comma-separated security tools (default: "gitleaks", only "gitleaks" allowed) SECURITY CONSIDERATIONS: - MAX_BUFFER_BYTES: Limited to 10MB to prevent memory exhaustion from malicious output. For very large outputs, output is truncated at this limit (tsc/cspell typically produce <1MB output). - Command whitelist: Only npx is allowed as the executable; specific args form the allowed command set (tsc, cspell, vitest, gitleaks). - Environment filtering: ONLY explicitly allow-listed env vars (NODE_PATH, PATH, HOME, LANG, LC_ALL) are passed to child processes. All other variables (including DF_* secrets) are explicitly blocked to prevent credential leakage into spawned subprocesses.

**Source:** [`agent/lib/dark-factory/tester-agent.ts`](../../agent/lib/dark-factory/tester-agent.ts)

**Exports:** `ALLOWED_ENV_KEYS`, `CheckResult`, `CommandRunner`, `PassFail`, `SecurityAlert`, `SecurityResult`, `TestResult`, `TesterAgent`, `TesterAgentConfig`, `ValidationError`, `ValidationFailedError`, `ValidationReport`, `ValidationRequest`, `createTesterAgent`, `createValidationReport`, `defaultCommandRunner`, `parseErrorOutput`, `toValidationRequest`

## trigger

Dark Factory — the kick-off trigger (#163). Mirrors `agent/lib/story-trigger.ts` deliberately: a payload type, env-overridable defaults, a PURE decision unit-testable offline, and a terminal-label guard so a re-applied label cannot start a second run. One trigger style in the repo, not two. TWO fail-closed gates, because a label alone is not authorisation: the repo must be in `DF_WORKER_ALLOWED_REPOS` and the ACTOR (`sender.login`) in `DF_TRIGGER_ALLOWED_USERS`. On a public repo anyone can apply a label, so without the actor gate the trigger is forgeable. Unset or empty ⇒ REFUSE — the lesson from #78, where an absent configuration was read as permission to relax the control. The decision carries a REASON rather than a boolean, because the outcomes differ to a caller: `not-a-trigger` is a 200 fall-through ("nothing for us"), while `refused` is a gate doing its job and must be visible.

**Source:** [`agent/lib/dark-factory/trigger.ts`](../../agent/lib/dark-factory/trigger.ts)

**Exports:** `DarkFactoryTriggerDecision`, `DarkFactoryTriggerDefaults`, `DarkFactoryTriggerKind`, `DarkFactoryTriggerPayload`, `MAX_BRIEF_BODY_CHARS`, `MAX_BRIEF_TITLE_CHARS`, `MAX_REASON_CHARS`, `TRIGGER_DEFAULTS`, `TRIGGER_LABELS`, `decideDarkFactoryTrigger`, `resolveTriggerAllowedUsers`, `resolveTriggerLabel`

## usage-ledger

Dark Factory — canonical LLM usage ledger record (#209, epic #206 R7.3). One provider-neutral shape describing the MEASURED usage of an LLM call or task. The honesty rule (#158) is enforced here, at the single contract point: an unmeasured value is ABSENT, never zero-filled, because "not measured" and "measured zero" are different facts and defaulting one to the other drags every aggregate toward a number nobody observed. Counts only: this module never carries prompt or completion text.

**Source:** [`agent/lib/dark-factory/usage-ledger.ts`](../../agent/lib/dark-factory/usage-ledger.ts)

**Exports:** `InvalidUsageEventError`, `MAX_USAGE_COST_USD`, `MAX_USAGE_IDENTIFIER_LENGTH`, `MAX_USAGE_LATENCY_MS`, `MAX_USAGE_TOKENS`, `UsageEvent`, `toUsageEvent`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## usage-query

Dark Factory — usage dashboard report (#209, epic #206 R7.3). Pure shaping for the operator dashboard: validates the time window, reads the ledger through the seam, and hands back a report whose unmeasured values stay ABSENT so the UI renders `—` instead of a misleading `0`. Operator-only and read-only. Counts only — no prompt or completion text. A malformed window is a CALLER error (400) and is deliberately distinguished from an unavailable ledger (503): conflating the two would send an operator hunting for a database outage when they simply typed a bad date.

**Source:** [`agent/lib/dark-factory/usage-query.ts`](../../agent/lib/dark-factory/usage-query.ts)

**Exports:** `InvalidUsageWindowError`, `UsageQueryParams`, `UsageQueryResult`, `UsageReport`, `normalizeUsageWindow`, `queryUsage`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## usage-store-postgres

Dark Factory — PostgreSQL usage ledger adapter (#209, epic #206 R7.3). Standard `pg` only; no vendor SDK. The ledger is append-only: events are inserted and never updated or deleted. `summarizeUsage` remains the semantic authority for the window and sum rules; the SQL `WHERE` is only an optimisation, and the same query is re-applied in memory so a row that slipped through the SQL filter still cannot change the answer. That keeps the deployed adapter agreeing with the in-memory one.

**Source:** [`agent/lib/dark-factory/usage-store-postgres.ts`](../../agent/lib/dark-factory/usage-store-postgres.ts)

**Exports:** `PostgresUsageStore`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## usage-store-provider

Dark Factory — usage store driver factory (#209, epic #206 R7.3). Recording is OPT-IN: with no driver set the in-memory adapter is used, which writes nowhere external. An explicit `postgres` or `sqlite` driver is required before anything leaves the process, so enabling this feature cannot break an existing deployment. The `isDeployedRuntime` rule is repeated here rather than shared: the same three-line predicate is currently private in `run-history-provider.ts` and inlined in `control.ts` / `cost-budget-store.ts`. Consolidating all four is a cross-module refactor, deliberately out of scope for this issue.

**Source:** [`agent/lib/dark-factory/usage-store-provider.ts`](../../agent/lib/dark-factory/usage-store-provider.ts)

**Exports:** `UsageConfigurationError`, `createUsageStore`, `isUsageRecordingConfigured`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## usage-store-sqlite

Dark Factory — local SQLite usage ledger (#209, epic #206 R7.3). File-backed adapter for local development and contract testing. Local-only: the driver factory refuses it in a deployed runtime. The read path reuses `summarizeUsage` rather than re-implementing the window and sum semantics in SQL, so a local run and an in-memory run can never disagree about what "measured" means.

**Source:** [`agent/lib/dark-factory/usage-store-sqlite.ts`](../../agent/lib/dark-factory/usage-store-sqlite.ts)

**Exports:** `SqliteUsageStore`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## usage-store

Dark Factory — LLM usage ledger store seam (#209, epic #206 R7.3). The write/read contract every driver implements, plus an in-memory default and a no-loss buffered decorator. Mirrors the run-history seam: results are structured (`{ok, mode, providerId, …}`) rather than thrown, so a store outage surfaces as `ok: false` instead of terminating the caller. Recording is OPT-IN: an unset driver resolves to the in-memory adapter, which keeps everything in-process and writes nowhere external.

**Source:** [`agent/lib/dark-factory/usage-store.ts`](../../agent/lib/dark-factory/usage-store.ts)

**Exports:** `BufferedUsageRecorder`, `InMemoryUsageStore`, `UsageAggregate`, `UsageDayTotals`, `UsageModelTotals`, `UsageQuery`, `UsageReadResult`, `UsageRunTotals`, `UsageStore`, `UsageTenantTotals`, `UsageWriteResult`, `recordSafely`, `summarizeUsage`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## worker-cost-env

Dark Factory — worker cost-budget contract (#208 R1 task 6). The sandbox never receives a database URL or a credential. Instead it receives a small, non-secret contract telling it WHICH cost category its LLM calls belong to and that governance is active; the orchestrator owns the store and adjudicates the reserve/settle calls. Returns `null` when governance is disabled so an unconfigured deployment is unchanged.

**Source:** [`agent/lib/dark-factory/worker-cost-env.ts`](../../agent/lib/dark-factory/worker-cost-env.ts)

**Exports:** `WORKER_COST_CATEGORY_VAR`, `WORKER_COST_ENABLED_VAR`, `WORKER_COST_PERIOD_VAR`, `WorkerCostBudgetEnv`, `WorkerCostCategory`, `buildWorkerCostEnv`

**Decisions:** [ADR 0002](../../docs/adr/0002-r1-records-r2-refuses.md)

## worker-env

Dark Factory — Containerised compute & code access (issues #130 / story #135). A PROVIDER SEAM: provision -> pushContext -> exec -> destroy, with a selector for WHERE the environment runs and a `local` default honestly reported as a dry-run (`mode: "dry-run"`, `isolated: false`) rather than claiming isolation it cannot provide. Real isolation arrives with an e2b/modal adapter once keys exist — R2 ships the seam, not a container.

**Source:** [`agent/lib/dark-factory/worker-env.ts`](../../agent/lib/dark-factory/worker-env.ts)

**Exports:** `DestroyResult`, `ExecResult`, `InvalidWorkerTaskError`, `LocalWorkerProvider`, `ProvisionResult`, `PushResult`, `WorkerContext`, `WorkerDeps`, `WorkerHandle`, `WorkerHandlerDeps`, `WorkerProvider`, `WorkerRunResult`, `WorkerRuntime`, `WorkerTask`, `createWorkerHandler`, `createWorkerProvider`, `resolveCredentialTtlSeconds`, `resolveWorkerAllowedRepos`, `resolveWorkerRuntime`, `toWorkerTask`, `withWorker`

**Decisions:** [ADR 0002](../../docs/adr/0002-r1-records-r2-refuses.md)

## worker-policy-env

Dark Factory — worker LLM policy contract (#208, epic #206 R7.2). The sandbox never receives a credential. Instead it receives the NON-SECRET LLM policy governing its calls, so a worker's thinking level and step bound match the orchestrator's. Returns `null` when no policy is configured, so an unconfigured deployment's sandbox is unchanged. The injected names are the canonical `DF_LLM_*` variables, so a sandbox can call `resolveLlmPolicy(process.env)` and reach the same answer rather than re-deriving the mapping — one definition of the policy, not two.

**Source:** [`agent/lib/dark-factory/worker-policy-env.ts`](../../agent/lib/dark-factory/worker-policy-env.ts)

**Exports:** `WorkerPolicyEnv`, `buildWorkerPolicyEnv`

**Decisions:** [ADR 0002](../../docs/adr/0002-r1-records-r2-refuses.md)

## worker-reporter

Dark Factory — WorkerReporter (#162): worker progress, completion and questions on the issue ticket itself. Before this, an autonomous run was SILENT on the ticket it was working on: a worker's progress reached only `DispatchObserver` → `MetricsStore` (#140), which is a sensor, not a human-facing channel. Operators had to read container logs to tell whether a run was progressing, finished, or stuck waiting on them. SECURITY SHAPE — why the reporter lives here and not in the worker: it runs TRUSTED-SIDE in Eve's process. The sandbox's environment is scrubbed by `tester-agent`'s `ALLOWED_ENV_KEYS`, and the token this module holds is never passed to a `WorkerTask`, so "the sandbox holds no repository credential" is true by construction rather than by care. The worker EMITS; Eve posts. NOISE SHAPE — one rolling comment per run, idempotent by `(runId, kind)`: the posted comment ids persist in the `StateStore` under `reporter:${runId}` (mirroring `dispatchKey`), so a retried or re-delivered emission EDITS the recorded comment. A 10-iteration task cannot spam a ticket, and a re-delivery cannot pile up duplicates — the failure mode this repo has been bitten by. FAIL-CLOSED: with no provider configured the default is the console/dry-run provider and NOTHING is written; a repo outside `resolveWorkerAllowedRepos()` is refused before any call is made. An unconfigured deployment writes nothing.

**Source:** [`agent/lib/dark-factory/worker-reporter.ts`](../../agent/lib/dark-factory/worker-reporter.ts)

**Exports:** `ConsoleReporter`, `GitHubCommentReporter`, `GitHubCommentReporterOptions`, `InvalidWorkerMessageError`, `MAX_ATTEMPT`, `MAX_QUESTION_CHARS`, `MAX_TEST_EVIDENCE_CHARS`, `MAX_TEST_EVIDENCE_LINES`, `ReportResult`, `WorkerMessage`, `WorkerMessageKind`, `WorkerReporter`, `createWorkerReporter`, `renderMessage`, `reporterKey`, `toWorkerMessage`

**Decisions:** [ADR 0002](../../docs/adr/0002-r1-records-r2-refuses.md)

## worker-usage

Dark Factory — worker usage recording (#209, epic #206 R7.3). The worker-side counterpart of `scripts/pr-reviewer-usage.ts`: it appends a usage event when a developer/tester task completes, carrying whatever was actually MEASURED. A worker's LLM call runs inside the sandbox, so tokens and cost are usually not observable from here. The event is still recorded — with those fields ABSENT — which is precisely what the honesty rule exists for: the dashboard shows `—`, and the event counts toward `unmeasured` rather than pretending the task cost nothing. Recording is OPT-IN and BEST-EFFORT: a ledger outage, or a malformed event, must never fail the task. Every suppressed failure is logged, so "best-effort" never means "silently broken".

**Source:** [`agent/lib/dark-factory/worker-usage.ts`](../../agent/lib/dark-factory/worker-usage.ts)

**Exports:** `WorkerUsageContext`, `WorkerUsageMeasurement`, `WorkerUsageRecorder`, `createWorkerUsageRecorder`

**Decisions:** [ADR 0002](../../docs/adr/0002-r1-records-r2-refuses.md)
