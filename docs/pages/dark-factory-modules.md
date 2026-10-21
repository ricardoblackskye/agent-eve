<!-- markdownlint-disable MD013 MD049 -->

# Dark Factory module catalog

> The authoritative index of every module under `agent/lib/dark-factory/`. Each
> entry states the module's purpose (from its own header comment) and its key
> exports, and links to the source. This page is what the **doc drift guard**
> (issue #238) checks: every module must appear here (or in another docs page) or
> CI fails — so a new subsystem cannot ship undocumented. The narrative companion
> is [Dark Factory (R1)](dark-factory.md) and the flow walkthroughs in the
> [flow deep-dives](flow-run-lifecycle.md).

_107 modules._

## agent-cli-author

The sandbox CLI author (#281, R2): runs a coding-agent CLI inside the sandbox with its base URL
pointed at the governed gateway and a per-run LEASE as its credential. A failed CLI run is
never treated as authored code, and `withSandbox` always releases the sandbox.

**Source:** [`agent/lib/dark-factory/agent-cli-author.ts`](../../agent/lib/dark-factory/agent-cli-author.ts)

## architect-discovery

Dark Factory - Architect discovery (#381 R1). Derives what each reachable file IS and how it composes, so the Architect can plan from evidence instead of a file list. A file rendering a route outlet is a shell; a component reached from more than one page is shared, with the pages named as the proof; the route table is parsed and each route's component resolved through that file's own imports. Deterministic by design - it makes NO model call, so planning stays one governed call per attempt. A role comes from what a file does, never from its name, which is why a file called MainPage that renders an outlet is still a shell.

**Source:** [`agent/lib/dark-factory/architect-discovery.ts`](../../agent/lib/dark-factory/architect-discovery.ts)

**Exports:** `DiscoveredFile`, `DiscoveryInput`, `DiscoveryResult`, `FileRole`, `discoverArchitecture`

## architect-agent

Dark Factory — Architect Agent (#179). Pre-code planning agent that inspects the repository file tree, analyzes the User Story and Acceptance Criteria, and synthesizes an ExecutionPlan. Self-corrects via feedback loops when generated plans fail domain validation.

**Source:** [`agent/lib/dark-factory/architect-agent.ts`](../../agent/lib/dark-factory/architect-agent.ts)

**Exports:** `ArchitectAgent`, `ArchitectDeps`, `ArchitectResult`, `DEFAULT_LOWEST_PRIORITY_SCORE`, `DEFAULT_MAX_CONTEXT_FILES`, `MAX_STORY_BODY_LENGTH`, `MAX_STORY_TITLE_LENGTH`, `ProcessTimerRegistry`, `StoryInput`, `sanitizeRelativePath`, `sortFilesByRelevance`

## architect-prompt

Dark Factory — the Architect's target contract (#381 R2 Task 8). The part of the planning prompt that says what may be targeted, as a pure function, because it is prompt BEHAVIOUR and prompt behaviour is testable. It exists because a line of prompt asked for "UI entrypoints under app/ or components/" whenever a story mentioned "page" — which is how a story about the main page of a Vite app produced targets called `src/components/Header.js` and `src/index.js` for a repository containing neither, while discovery had already proved which file the page is. The contract mandates the resolved page for a page-scoped story, names the shell and shared files as forbidden WITH the reason, requires every path to appear in the file list, and keeps `app/` + `components/` only as a fallback for when discovery resolved no page. Its forbidden list is capped, so it has a bounded cost against the prompt budget.

**Source:** [`agent/lib/dark-factory/architect-prompt.ts`](../../agent/lib/dark-factory/architect-prompt.ts)

**Exports:** `TargetContractInput`, `buildTargetContract`

## breaker-trip-recorder

Dark Factory — record a circuit-breaker trip on a run (#313). A trip halts the coding loop (#312), and an operator reading the ticket must be able to see WHY it stopped and what bound was exceeded — not just find it in a log. The trip is stored machine-readably (a closed vocabulary of reasons plus the numeric bound), never free text, and the breaker itself stays a pure in-memory guard: it is never taught about the ledger. Mirrors `cost-refusal-recorder.ts` (#270) deliberately — same shape, same idempotency, same honest failure reporting.

**Source:** [`agent/lib/dark-factory/breaker-trip-recorder.ts`](../../agent/lib/dark-factory/breaker-trip-recorder.ts)

**Exports:** `RecordBreakerTripInput`, `RecordBreakerTripResult`, `recordBreakerTrip`

**Decisions:** [ADR 0024](../../docs/adr/0024-record-the-trip-on-the-run.md)

## breaker-wiring

Dark Factory — circuit-breaker wiring for the coding loop (#312). The breaker was a complete guard that nothing ever constructed, so no trip could occur (see #308). This module owns the two things the coding loop deliberately does not know about: the KEY — the ISSUE, not the run, because a run id contains `/` and `#`, which `PBI_ID_PATTERN` rejects, and a per-run key would reset the budget on every retry — and the BINDING of a breaker into the loop's narrow seam. The breaker is a GUARD, not telemetry: once a PBI's budget is exceeded the coding loop halts fail-closed at its next cooperative boundary.

**Source:** [`agent/lib/dark-factory/breaker-wiring.ts`](../../agent/lib/dark-factory/breaker-wiring.ts)

**Exports:** `PBI_ID_PREFIX`, `createCodingLoopBreaker`, `pbiIdForIssue`

## child-env

Dark Factory — the ONE allow-list of environment variables an agent may hand to a child process (#275). `child_process.exec`/`execFile` INHERIT the parent environment when `env` is omitted, so in a deployed runtime a command run by an agent could read the push token, every `DF_*` knob and any database URL. The tester agent filtered this from the start; the developer agent did not, which is exactly the gap #275 names ("verify dev-agent env filtering like tester-agent"). Both now consume this module so the list cannot drift. Minimal by decision: `NODE_PATH`, `PATH`, `HOME`, `LANG`, `LC_ALL` only. Fail-closed: a missing source yields an EMPTY object, never the parent environment.

**Source:** [`agent/lib/dark-factory/child-env.ts`](../../agent/lib/dark-factory/child-env.ts)

**Exports:** `ALLOWED_CHILD_ENV_KEYS`, `filterChildEnv`

## circuit-breaker

Dark Factory — Factory-level circuit breaker / cost guard (issues #143 / story #144). A cross-task safety guard that caps cumulative worker-minutes per PBI and escalates after a configured number of failed self-correct cycles. Independent additive guard on top of the per-task retry/iteration bounds in #138 and #133. DESIGN DECISIONS: - State is IN-MEMORY (no persistence). Trip events are emitted for external logging; the breaker only needs the PBI's _current_ state, not historical data. - Math.ceil() for ms→min conversion ensures we NEVER under-count toward the budget. A minimum duration threshold (5 seconds) prevents sub-second exploitation. Maximum over-count is: 59,999ms rounds up to 1 minute (59,999 < 60,000 < 120,000). - PBI_ID_PATTERN allows only alphanumeric, underscores, and hyphens (no periods) to prevent path traversal attacks if IDs are used in file paths or URLs. **IMPORTANT**: When constructing file paths or URLs, use encodeURIComponent() or similar encoding for additional safety, even with pattern restrictions. - Trip events are capped at 100 per PBI to prevent DoS attacks via event flooding.

**Source:** [`agent/lib/dark-factory/circuit-breaker.ts`](../../agent/lib/dark-factory/circuit-breaker.ts)

**Exports:** `CircuitBreaker`, `CircuitBreakerConfig`, `DFLT_MAX_STATE_ENTRIES`, `DFLT_MAX_TOTAL_TRIP_EVENTS`, `DFLT_MAX_TRIPS_PER_PBI`, `DFLT_MAX_WORKER_MINUTES`, `DFLT_MIN_DURATION_MS`, `EnvConfigError`, `InvalidTripEventError`, `MIN_AUTO_CLEANUP_MS`, `PBI_ID_MAX_LENGTH`, `TripEvent`, `TripReason`, `TripTimestamp`, `WorkerActivity`, `WorkerActivitySink`, `createCircuitBreaker`, `createWorkerActivityObserver`, `toTripEvent`, `validateWorkerActivity`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## code-author

The code AUTHOR seam (#281, R2). Declares `CodeAuthorProvider`, a fail-closed refusing default,
and an `in-process` adapter that preserves today's prompt and JSON extraction verbatim.

**Source:** [`agent/lib/dark-factory/code-author.ts`](../../agent/lib/dark-factory/code-author.ts)

## code-author-provider

Resolves the code AUTHOR from `DF_CODE_AUTHOR`. Unset or blank means `in-process`; an unknown
value refuses at startup. There is no boolean flag, so the default cannot be flipped open by accident.

**Source:** [`agent/lib/dark-factory/code-author-provider.ts`](../../agent/lib/dark-factory/code-author-provider.ts)

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

## llm-gateway

The governed model gateway core (#281, R2): deny-by-default lease check, model allow-list, and
the existing `runGovernedLlmCall` seam. Refuses rather than forwarding ungoverned.

**Source:** [`agent/lib/dark-factory/llm-gateway.ts`](../../agent/lib/dark-factory/llm-gateway.ts)

## opensandbox-driver

The live sandbox execution driver (#281, R2): serves `WorkspaceTools` from inside an OpenSandbox,
re-applying the same extension and test-command guards, with deny-by-default egress and an
explicit `dispose()` because closing a sandbox client does not terminate the sandbox.

**Source:** [`agent/lib/dark-factory/opensandbox-driver.ts`](../../agent/lib/dark-factory/opensandbox-driver.ts)

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

## gateway-recorder

Dark Factory — record the governed gateway's decisions into run-history (#281, R2b/B3). Adapts the gateway's optional `recordUsage`/`recordRefusal` hooks (invoked by the core with the run id from the lease) to run-history writes: a forwarded call appends a `run.cost` event carrying the estimated USD, and a refusal appends the machine-readable `CostGovernorRefusal` code. A history outage is swallowed, so it can never fail a forwarded call.

**Source:** [`agent/lib/dark-factory/gateway-recorder.ts`](../../agent/lib/dark-factory/gateway-recorder.ts)

**Exports:** `GatewayRecorder`, `createGatewayRecorder`

**Decisions:** [ADR 0030](../../docs/adr/0030-df-llm-gateway.md)

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

## operator-actions

Dark Factory — operator retry / abort, the ledger-reaching half (#307). `performOperatorRunAction` is the seam behind the two operator actions that need the run ledger rather than the control-state flags: `abort` drives the ledger's existing terminal abort transition (so the run-history status becomes `aborted`, which is what distinguishes it from a flag-only `stop`), and `retry` re-dispatches a FAILED run as a NEW run. The delivery identity is derived from the run, so a repeated click is idempotent through the ledger's claim/accept dedupe.

**Source:** [`agent/lib/dark-factory/operator-actions.ts`](../../agent/lib/dark-factory/operator-actions.ts)

**Exports:** `DispatchFn`, `OperatorActionDeps`, `OperatorActionInput`, `OperatorActionResult`, `OperatorRunAction`, `operatorDeliveryId`, `performOperatorRunAction`

**Decisions:** [ADR 0023](../../docs/adr/0023-retry-is-a-new-run-abort-is-terminal.md)

## notifications

Dark Factory — the notification seam (#317). A run's labels and comments are the record ON the ticket: they reach only someone already looking. This is the missing out-of-band push, so a run's outcome reaches a human without them polling. PROVIDER-NEUTRAL: a canonical bounded payload plus a provider interface, so the channel is a seam choice rather than a rewrite, and no vendor is named here. The payload carries NO secrets and NO free text — the run-history no-raw-content rule applied to a second egress point. FAIL-CLOSED and OPT-IN: with nothing configured the default is a no-op that reports it is not configured and never claims a delivery it did not perform, while an unknown driver THROWS so a typo surfaces instead of silently losing notifications.

**Source:** [`agent/lib/dark-factory/notifications.ts`](../../agent/lib/dark-factory/notifications.ts)

**Exports:** `ConsoleNotificationProvider`, `NOTIFICATION_KINDS`, `Notification`, `NotificationConfigurationError`, `NotificationInput`, `NotificationKind`, `NotificationProvider`, `NotifyResult`, `createNotificationProvider`, `isNotificationsConfigured`, `toNotification`

## notifying-run-history

Dark Factory — drive notifications from the ledger (#317). Every write path in the factory reaches the run history through `RunHistoryStore`, so this DECORATES the store and inspects each write: no lifecycle site needs a call and no path can be forgotten (the failure mode that produced three dead seams already). IDEMPOTENT: a transition is announced once — the ledger's `duplicate` flag is the primary guard and a bounded in-process set of `(runId, eventId)` backs it up, so a re-delivered webhook or a retried run cannot spam the channel. BEST-EFFORT: a notification can never fail a run, and every suppression is logged rather than silent.

**Source:** [`agent/lib/dark-factory/notifying-run-history.ts`](../../agent/lib/dark-factory/notifying-run-history.ts)

**Exports:** `MAX_REMEMBERED_TRANSITIONS`, `NotifyingRunHistoryOptions`, `NotifyingRunHistoryStore`, `notificationKindFor`, `withNotifications`

## operator-cli

Operator CLI for the self-improvement gate (#159). The gate in `self-improve.ts` blocks every `access-widening` proposal until a decision is recorded ("blocked: operator gate missing"), and NOTHING in the application records one: `createOperatorDecisionStore` is re-exported but never called outside its test. This module is therefore the only way the gate can be satisfied, which is why every rule below is fail-closed. Deliberately PURE: it takes an injected decision store and clock and returns `{ lines, exitCode }`. No `process`, no `console`, no filesystem — so the behaviour is provable in tests and identical wherever it is invoked.

**Source:** [`agent/lib/dark-factory/operator-cli.ts`](../../agent/lib/dark-factory/operator-cli.ts)

**Exports:** `OPERATOR_CLI_USAGE`, `OperatorCliCommand`, `OperatorCliDeps`, `OperatorCliResult`, `OperatorCliUsageError`, `OperatorDecisionValue`, `ProposalKind`, `parseOperatorArgs`, `runOperatorCli`

## plan-approval

Dark Factory — Plan Approval Gate (#365 R4). Parks the run after the plan is posted and before any code is written, so a human authorizes the plan first. Recording the question is the park itself: `run-history` derives the run's status from a `worker.question`, and the resume path (`trigger`, `entry`) only ever resumes a run whose status is `blocked`. The comment is recorded before the label is applied, so a label outage cannot hide the question. A park can ask something other than approval (#381 R2 AC4): when the Architect cannot justify a target, the question is which surface the story means, so a human is not asked to approve a plan that does not exist. A park can also answer a plan that never validated (#381 R2 Task 8): the question points at the validation errors on the ticket rather than at approval, because a human can say what should change and a terminal failure could not be answered at all. The event id stays keyed on the run and the round, so a re-delivery of the same park still records once.

**Source:** [`agent/lib/dark-factory/plan-approval.ts`](../../agent/lib/dark-factory/plan-approval.ts)

**Exports:** `PLAN_APPROVAL_QUESTION`, `PLAN_INVALID_QUESTION`, `TARGET_UNRESOLVED_QUESTION`, `ParkForApprovalOptions`, `ParkResult`, `PlanApprovalDeps`, `PlanApprovalLabels`, `PlanApprovalReporter`, `parkForApproval`, `planApprovalEventId`

## plan-comment

Dark Factory — Plan Comment (#365). Posts the rendered plan on the ticket right after planning and before the coding loop, so a run that later fails still leaves reviewable intent. The comment carries a marker, which makes it idempotent: a retry finds its own comment and updates it rather than stacking another one on the ticket.

**Source:** [`agent/lib/dark-factory/plan-comment.ts`](../../agent/lib/dark-factory/plan-comment.ts)

**Exports:** `PLAN_COMMENT_MARKER`, `PlanCommentRecord`, `PlanCommentResult`, `PlanCommentTarget`, `PostPlanCommentOptions`, `findPlanComment`, `planCommentBody`, `postPlanComment`

## plan-file

Dark Factory — Plan File Renderer (#361). Renders an ExecutionPlan as reviewable markdown, so a run that fails before its commit still leaves its intent on the branch. The output is constrained by this repository's markdown linting (MegaLinter lints changed markdown in the pull request): every fenced block carries a language (MD040), task headings are numbered so they never repeat (MD024), heading text is stripped of trailing punctuation (MD026), and table cells have their pipes escaped. `approach` and `tasks` are optional, so a plan that does not carry them renders without those sections.

**Source:** [`agent/lib/dark-factory/plan-file.ts`](../../agent/lib/dark-factory/plan-file.ts)

**Exports:** `PlanFileInput`, `PlanTask`, `renderPlanFile`

## plan-response

Dark Factory — Plan Response (#378). Decides whether a human's reply to a parked plan is an explicit approval or revision feedback. Approval is OPT-IN and fail-closed: only explicit approval wording counts, and every other reply is treated as feedback, which amends the plan and re-parks the run rather than coding. The approval test is a WHOLE-MESSAGE match against one allow-list, so a reply carrying both an approval and a request is feedback. Also resolves the revision cap from `DF_MAX_PLAN_REVISIONS`, refusing a malformed or non-positive value rather than defaulting it silently.

**Source:** [`agent/lib/dark-factory/plan-response.ts`](../../agent/lib/dark-factory/plan-response.ts)

**Exports:** `DEFAULT_MAX_PLAN_REVISIONS`, `MAX_PLAN_REVISIONS_ENV`, `PLAN_APPROVAL_PHRASES`, `PlanResponseDecision`, `PlanResponseKind`, `classifyPlanResponse`, `resolveMaxPlanRevisions`

## plan-revision-recorder

Dark Factory — Plan Revision Rounds (#378). The durable count of how many times a parked plan has been sent back, which the runner refuses against once the cap is reached. A reply that is not an explicit approval is plan feedback: it costs one architect call and re-parks the run, so without a bound an unrelated comment could send the architect round the loop indefinitely. A round is recorded as a `run.resumed` event, because that is what the reply IS — the ledger permits a BLOCKED run only `run.resumed` or `run.terminal`, which is the rule that stops a parked run accumulating work while it waits. The event id is derived from the run and the reply identity, so a re-delivered comment records once while a genuinely new reply is a new round. An unreadable ledger is REPORTED rather than answered as zero, because a zero fallback would silently disable the cap; a store that REJECTS is reported the same way as one that returns a failure, since a rejection would otherwise escape the caller. Paging is capped at the store's own maximum of 100 rows per read.

**Source:** [`agent/lib/dark-factory/plan-revision-recorder.ts`](../../agent/lib/dark-factory/plan-revision-recorder.ts)

**Exports:** `PlanRevisionCountResult`, `PlanRevisionWriteResult`, `RecordPlanRevisionInput`, `countPlanRevisions`, `isPlanRevisionCapReached`, `readPlanRevisionCount`, `recordPlanRevision`

## plan-validator

Dark Factory — Execution Plan Domain Validator (#179). Pre-flight validation gate that evaluates an ExecutionPlan produced by the Architect Agent before code generation begins. Ensures plans touch appropriate repository domains (e.g. UI/Chat stories modify UI entrypoints) and that every Acceptance Criterion from the User Story is mapped to an automated test case. A plan is also judged against the repository when discovery supplies a context (#381 R2): a story scoped to one page may not target the application shell or a component rendered on more than one page, and the refusal names the file, the role, the evidence that proves it, and the page to use instead. The context is OPTIONAL, so the validator stays a pure function of its arguments and every earlier caller is unchanged.

**Source:** [`agent/lib/dark-factory/plan-validator.ts`](../../agent/lib/dark-factory/plan-validator.ts)

**Exports:** `AcceptanceCriteriaTestMapping`, `DefaultPlanParser`, `ExecutionPlan`, `PlanFileRole`, `PlanParser`, `PlanTargetFile`, `PlanValidationContext`, `PlanValidationResult`, `StoryScope`, `extractStoryAcceptanceCriteria`, `isPageScopedStory`, `isShellScopedStory`, `safeJsonParse`, `validateExecutionPlan`

## platform-auth

Select the optional platform authenticator while preserving common auth order. The Vercel authenticator factory is lazy so a generic deployment neither constructs nor depends on Vercel OIDC behavior.

**Source:** [`agent/lib/dark-factory/platform-auth.ts`](../../agent/lib/dark-factory/platform-auth.ts)

**Exports:** `selectPlatformAuth`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## platform

Platform-specific runtime facts consumed by Dark Factory. Provider-specific environment variables are read only in these adapters. The orchestration consumes the normalized context and never needs to know how a host names its deployment stage or URL.

**Source:** [`agent/lib/dark-factory/platform.ts`](../../agent/lib/dark-factory/platform.ts)

**Exports:** `DeploymentStage`, `PlatformAdapter`, `PlatformConfigurationError`, `PlatformContext`, `PlatformProviderId`, `createPlatformAdapter`

## planning-guidance

Dark Factory — Planning Guidance (#361). Supplies the vendored Superpowers "writing-plans" guidance to the Architect Agent's prompt, so a plan arrives with an approach and a task breakdown instead of a bare list of files. The guidance is vendored rather than fetched, because the architect runs in a sandbox with no outbound access to GitHub; `docs/superpowers/writing-plans.md` holds a verbatim copy pinned to an upstream commit, with its source, license and sync instructions. `planningGuidanceForPrompt` strips that maintainer-facing header before the model sees it.

**Source:** [`agent/lib/dark-factory/planning-guidance.ts`](../../agent/lib/dark-factory/planning-guidance.ts)

**Exports:** `PLANNING_GUIDANCE_SOURCE`, `WRITING_PLANS_GUIDANCE`, `planningGuidanceForPrompt`

## preservation-guard

Dark Factory — Preservation Guard (#361). A pure comparison of a file's content before and after the coding loop touched it, so a destructive rewrite is refused at the loop boundary rather than reported as done. Compares trimmed non-blank lines with duplicates counted, so re-indenting a file is not mistaken for deleting it.

**Source:** [`agent/lib/dark-factory/preservation-guard.ts`](../../agent/lib/dark-factory/preservation-guard.ts)

**Exports:** `MAX_REMOVED_RATIO`, `PlanFileAction`, `PreservationInput`, `PreservationVerdict`, `assessPreservation`

## pr-writer

Dark Factory — PR Writer (#164). Provides the GitHub pull request creation primitive for the orchestrator. CRITICAL INVARIANTS: 1. Opening a PR is the terminal automated action. 2. Merging is STRICTLY forbidden for the factory — this module does NOT implement, expose, or call any merge endpoints. 3. Fail-closed: repository MUST be in DF_WORKER_ALLOWED_REPOS. 4. Injected fetchImpl for offline/deterministic testing without network calls.

**Source:** [`agent/lib/dark-factory/pr-writer.ts`](../../agent/lib/dark-factory/pr-writer.ts)

**Exports:** `CreatePullRequestOptions`, `CreatePullRequestResult`, `GitHubPrWriter`, `GitHubPrWriterOptions`, `PullRequestDetails`

**Decisions:** [ADR 0004](../../docs/adr/0004-story-publish-is-fail-closed.md)

## local-sandbox

The local execution adapter for the sandbox seam. It delegates to `createWorkspaceTools`, so every
existing guard (path traversal, symlink containment, extension allowlist, test-command allowlist)
keeps running unchanged.

**Source:** [`agent/lib/dark-factory/local-sandbox.ts`](../../agent/lib/dark-factory/local-sandbox.ts)

## run-attribution

Resolve the tenant a newly accepted run is attributed to (#213, epic #212 R1). Resolution is TOTAL, and that is the point: an unconfigured registry, an unassigned repository, a registry outage, or a store that throws all degrade to UNASSIGNED (undefined) rather than failing. R1 only RECORDS attribution — refusing to accept a run because it cannot be attributed would break existing operator flows before the repository seed has been applied everywhere. The refusal half of the contract belongs to R2, and is enforced there. An INACTIVE tenant still attributes. The run genuinely belongs to them, and historical attribution must not be rewritten when they are re-activated.

**Source:** [`agent/lib/dark-factory/run-attribution.ts`](../../agent/lib/dark-factory/run-attribution.ts)

**Exports:** `resolveRunTenant`

**Decisions:** [ADR 0001](../../docs/adr/0001-tenant-attribution-is-write-once.md)

## run-finalizer

Dark Factory — terminal lifecycle labels at run completion (#284). A finished run must carry a terminal label so it is distinguishable from an abandoned one on the ticket, and so the trigger re-run guard has something to key on. `applyTerminalLifecycle` is the single seam the runner calls on success and on every terminal-failure path: it applies `df:done` / `df:failed`, clears `df:running` and `needs-answer`, is idempotent (a re-delivery applies nothing) and fail-closed (a label-write failure is recorded on the run and thrown, never swallowed).

**Source:** [`agent/lib/dark-factory/run-finalizer.ts`](../../agent/lib/dark-factory/run-finalizer.ts)

**Exports:** `applyTerminalLifecycle`, `LabelWriteError`, `TerminalFinalizeArgs`, `TerminalFinalizeOutcome`, `TerminalFinalizerDeps`, `TerminalStatus`

**Decisions:** [ADR 0021](../../docs/adr/0021-terminal-labels-fail-closed.md)

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

## run-record

Dark Factory — open a run's record at the start of a run (#316). A run driven by `scripts/dark-factory-runner.ts` used to leave NO trace in the ledger: the runner invented its own id, which nothing else knew, so the run could not appear in the dashboard and the events it later appended attached to a run the ledger had never seen. This module uses the existing seam instead — the LEDGER owns run identity: it mints the id and is idempotent per delivery, so the same attempt is a no-op rather than a duplicate, and the runner adopts what comes back. A ledger that refuses (an unconfigured driver) is reported loudly and the attempt id is used as a fallback, so a local run still works: never a silent claim of recording, and it never throws.

**Source:** [`agent/lib/dark-factory/run-record.ts`](../../agent/lib/dark-factory/run-record.ts)

**Exports:** `BeginRunRecordInput`, `BeginRunRecordResult`, `beginRunRecord`, `runnerDeliveryId`

## runner-config

Dark Factory — resolve a run's target repository instead of hardcoding one (#348), and the per-repo settings that depend on it (#348 R2). Two concerns, kept apart: RESOLUTION decides which repository a run works on (`--repo`, else the `default_repo` in `dark-factory.config.json`, else refuse) and AUTHORIZATION decides whether it may be touched (the fail-closed `DF_WORKER_ALLOWED_REPOS` list in `credentials.ts`). The same file carries a `repos` map — the board a repository reports to, and the owner/repo a story is filed against — resolved by the same order (argument, then environment, then config) and REFUSED when nothing supplies a value, because a board defaulted to a number nobody chose is how work gets reported to the wrong Project. See ADRs 0037 and 0038. The runner previously answered the first with a literal and faked the second by setting the allow-list when it was unset, so an unconfigured deployment looked authorized while every run targeted one repository. The default is an operating choice and lives in config, never in code: a default in code is indistinguishable from a hardcode.

**Source:** [`agent/lib/dark-factory/runner-config.ts`](../../agent/lib/dark-factory/runner-config.ts)

**Exports:** `RUNNER_CONFIG_PATH`, `RunnerConfig`, `RunnerConfigResult`, `parseRunnerConfig`, `loadRunnerConfig`, `TargetRepoResult`, `TargetRepoSource`, `resolveTargetRepo`, `TargetRepoAuthorization`, `authorizeTargetRepo`, `IssueNumberResult`, `resolveIssueNumber`, `BranchNameResult`, `resolveBranchName`, `RepoSettings`, `RepoBoardSettings`, `RepoSettingsResult`, `resolveRepoSettings`, `resolveBoard`, `SettingSource`, `BoardSettingResult`, `resolveBoardSetting`, `OwnerRepoResult`, `resolveOwnerRepo`

## sandbox-reaper

Dark Factory — reap orphaned sandboxes by run id (#281, R2b/B4). Lists sandboxes labelled `metadata.run` and deletes them, reclaiming any sandbox left behind by a client-timeout create-leak. Defense in depth behind runCodingPhase's dispose; never aborts the run on a stuck orphan.

**Source:** [`agent/lib/dark-factory/sandbox-reaper.ts`](../../agent/lib/dark-factory/sandbox-reaper.ts)

**Exports:** `SandboxManagerLike`, `reapSandboxesByRun`

## sandbox

The provider-agnostic sandbox execution seam (#280, R1). Declares `SandboxProvider`, the fail-closed
refusing default and the `dry-run` provider. Nothing here is on by default.

**Source:** [`agent/lib/dark-factory/sandbox.ts`](../../agent/lib/dark-factory/sandbox.ts)

## sandbox-provider

Resolves the sandbox provider from `DF_SANDBOX_DRIVER`. Unset or blank means the local filesystem;
an unknown value refuses at startup before any side effect.

**Source:** [`agent/lib/dark-factory/sandbox-provider.ts`](../../agent/lib/dark-factory/sandbox-provider.ts)

## self-improve-state

Dark Factory — self-improvement PERSISTENCE adapters (#146, R4b). `self-improve.ts` deliberately imports no store: the controller is storage-agnostic, and this module is the one place that binds the loop to the existing `StateStore` seam (#134). Two things need durability: - the CADENCE WATERMARK — when a cycle last ran, so the caller's scheduler can ask "is a cycle due?" without a long-lived timer. - OPERATOR DECISIONS — a pre-armed human allow/deny for a (surface, kind) pair, which `operatorGateFromStore` turns into the `OperatorGate` the controller already consumes. Both use a single key holding a JSON value, because `StateStore` exposes only `save(key, value)` / `get(key)` — there is no key enumeration, so a list of decisions is stored as an array and upserted in place.

**Source:** [`agent/lib/dark-factory/self-improve-state.ts`](../../agent/lib/dark-factory/self-improve-state.ts)

**Exports:** `CADENCE_WATERMARK_KEY`, `OPERATOR_DECISIONS_KEY`, `OperatorDecision`, `OperatorDecisionStore`, `OperatorDecisionValue`, `SelfImprovementStateError`, `createCadenceWatermark`, `createOperatorDecisionStore`, `operatorGateFromStore`

## self-improve

Dark Factory — Measurable Recursive Self-Improvement (#146, R4a). One bounded, FAIL-CLOSED cycle: OBSERVE → read the aggregate metrics from #140 (never a parallel store) PROPOSE → a candidate change to a tunable surface + a written hypothesis APPLY → staged behind a versioned, reversible handle (never in place) MEASURE → re-run a fixed, deterministic benchmark set DECIDE → accept iff the objective improves and no guardrail regresses RECORD → append an immutable ledger entry {what, why, before → after, verdict} Every step is an injected interface, so no model, vendor or tool is named here. Reversibility and fail-closed verification are the whole point: an unverified self-improvement loop will happily improve itself into a regression. R4b adds the recurrence (cadence + trend report + operator CLI). SCAFFOLD: signatures are declared with real types so the test file collects; behaviour is implemented RED → GREEN per the plan's cycle table.

**Source:** [`agent/lib/dark-factory/self-improve.ts`](../../agent/lib/dark-factory/self-improve.ts)

**Exports:** `BenchmarkCase`, `BenchmarkMeasurer`, `CadenceInput`, `CadenceWatermark`, `CostGuard`, `CycleResult`, `DEFAULT_INTERVAL_MINUTES`, `DEFAULT_ITERATION_STEP`, `DEFAULT_TARGET_SUCCESS_RATE`, `Decision`, `DecisionConfig`, `ImprovementBenchmark`, `ImprovementLedger`, `InMemoryImprovementLedger`, `InvalidProposalError`, `IterationBoundSurface`, `LedgerEntry`, `MAX_BENCHMARK_EFFORT`, `Measurement`, `Measurer`, `ObjectiveTrend`, `Observation`, `Observer`, `OperatorGate`, `Proposal`, `ProposeOptions`, `Proposer`, `ScheduledRunOptions`, `ScheduledRunResult`, `SelfImprovementConfig`, `SelfImprovementConfigError`, `SelfImprovementController`, `SelfImprovementDeps`, `SelfImprovementEnvConfig`, `SupersededVersionError`, `TrendPoint`, `TunableSurface`, `VersionHandle`, `createSelfImprovementController`, `decide`, `isCycleDue`, `loadImprovementBenchmark`, `makeProposal`, `measureBenchmark`, `nextRunAt`, `objectiveTrend`, `observeTaskType`, `proposeFromObservation`, `resolveSelfImprovementEnvConfig`, `runImprovementCycle`, `runScheduledCycle`, `summarizeRecords`

## skill-set-surface

Dark Factory — the skill-set tunable surface (#157). The concrete surface that #146 AC8 only _seamed_: a real `TunableSurface` whose value is the set of enabled skills, persisted through the `StateStore` so that a restart does not forget it. Two constraints come straight from the interfaces it must satisfy: - `TunableSurface.read()` is **synchronous**, so the store cannot be read on every call: `createSkillSetSurface` loads the snapshot once (async) and caches it. That is why this is a factory rather than a constructor. - `VersionHandle` requires `previous`/`next` and an **idempotent** `revert()`, plus the superseded-handle guard `IterationBoundSurface` established: a stale handle must not be able to silently undo a newer change. Widening capability is the gated class: adding a skill is `access-widening`, so the controller cannot apply it without an armed operator decision (#159's CLI is how one is armed).

**Source:** [`agent/lib/dark-factory/skill-set-surface.ts`](../../agent/lib/dark-factory/skill-set-surface.ts)

**Exports:** `SkillEvidence`, `SkillSet`, `SkillSetSurface`, `createSkillSetSurface`, `proposeSkillAddition`

## skills

Dark Factory — skill catalogue (#157). A skill is a **capability grant**: a named capability defined by the permission delta it grants. This is the vocabulary that the skill-set surface (`skill-set-surface.ts`) tunes, and that the operator gate guards. SCOPE, decided by REVIEW rather than assumed: `ALLOWED_TOOLS` is the only tool vocabulary in this repository — a grep for tool-like names across `agent/lib/dark-factory/` returns exactly its four members — and the worker protocol takes a free-form command string, so there is **no registry a skill could add a tool to**. A skill that claimed to grant a new tool would be inventing capability that does not exist, so this catalogue does not offer that. What genuinely widens capability today is the **file-extension allow-list**: `.sql`, `.sh`, `.graphql` and `.prisma` are refused by `applySkeletalMap`. A skill granting one of those is a real, visible widening — and the refusal path that proves it is already tested. `tools` is kept in the grant shape for the day a registry exists, and a grant naming a tool this repo cannot honour is refused at catalogue load.

**Source:** [`agent/lib/dark-factory/skills.ts`](../../agent/lib/dark-factory/skills.ts)

**Exports:** `Capabilities`, `SKILLS`, `SKILL_NAMES`, `SkillCatalogueError`, `SkillDefinition`, `SkillGrant`, `SkillName`, `canonicaliseSkills`, `parseSkillName`, `resolveCapabilities`, `validateCatalogue`

## slack-notification

Dark Factory — Slack notification adapter (#318). The first REAL driver for the notification seam (#317): delivery via an incoming webhook URL — no vendor SDK, no OAuth, no app registration. The seam, the payload and the wiring already exist, so activating it is just `DF_NOTIFY_DRIVER=slack` plus the URL. SECRET DISCIPLINE: the webhook URL is a credential, so it is never logged, never placed in the request body, never written to the ledger, and never echoed in an error; an absent or malformed URL THROWS rather than failing silently. BEST-EFFORT and BOUNDED: a failure returns `{ ok: false }` rather than throwing (the seam already swallows it, so a notification can never fail a run), every attempt is bounded by a timeout, and it retries at most once — a 5xx or a timeout may be transient, while a 4xx is a configuration problem that must not be repeated.

**Source:** [`agent/lib/dark-factory/slack-notification.ts`](../../agent/lib/dark-factory/slack-notification.ts)

**Exports:** `DEFAULT_SLACK_TIMEOUT_MS`, `MAX_SLACK_ATTEMPTS`, `SlackFetch`, `SlackMessage`, `SlackNotificationConfigurationError`, `SlackNotificationOptions`, `SlackNotificationProvider`, `renderSlackMessage`

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

Dark Factory — Tester Agent (issues #132 / story #136). A pre-PR validation gate that runs static analysis, smoke tests, and security scans to catch quality and security regressions before merge. DESIGN DECISIONS: - Fail-closed defaults: missing config = no validation, failed check = block PR - Canonical payload pattern: ValidationRequest/ValidationReport for seams - Metrics emission: reports pass/fail via MetricsStore for observability - Dependency injection: CommandRunner interface for testability - Command whitelist: only allow npx commands (tsc, cspell, vitest, gitleaks) REQUIRED DEPENDENCIES: - `tsc` (TypeScript compiler, via npx) for static analysis - `cspell` (spell checker, via npx) for documentation quality - `vitest` (test runner, via npx) for smoke tests - `gitleaks` (secret scanner, via npx) for security scan (optional) EXPECTED PROJECT STRUCTURE: - agent/lib/dark-factory/_.ts — source under test - tests/dark-factory/_.test.ts — corresponding test files ENVIRONMENT VARIABLES (read by createTesterAgent): - DF*SECURITY_SCAN_ENABLED: "true" to enable gitleaks scan (default: false) - DF_TESTER_TIMEOUT_MS: per-check timeout in ms (default: 60000) - DF_SECURITY_TOOLS: comma-separated security tools (default: "gitleaks", only "gitleaks" allowed) SECURITY CONSIDERATIONS: - MAX_BUFFER_BYTES: Limited to 10MB to prevent memory exhaustion from malicious output. For very large outputs, output is truncated at this limit (tsc/cspell typically produce <1MB output). - Command whitelist: Only npx is allowed as the executable; specific args form the allowed command set (tsc, cspell, vitest, gitleaks). - Environment filtering: ONLY explicitly allow-listed env vars (NODE_PATH, PATH, HOME, LANG, LC_ALL) are passed to child processes. All other variables (including DF*\* secrets) are explicitly blocked to prevent credential leakage into spawned subprocesses.

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

## lease-broker

Dark Factory — credential lease broker (#282 R3/T4). Opaque, run-scoped leases: issuance is separated from adjudication, redemption is server-side only, and revoking an absent lease is a no-op (404-as-success). The allow-list is enforced at the seam and fails closed when empty.

**Source:** [`agent/lib/dark-factory/lease-broker.ts`](../../agent/lib/dark-factory/lease-broker.ts)

**Exports:** `createLeaseBroker`, `LeaseScope`, `Lease`, `Adjudication`, `LeaseBroker`, `LeaseBrokerOptions`

**Decisions:** [ADR 0035](../../docs/adr/0035-df-sandbox-credential-vault.md)

## credential-vault

Dark Factory — write-only credential vault (#282 R3). A secret is stored once and can never be read back through the public surface; it is retrieved only via an opaque, server-side lease. The host-side `InMemoryCredentialVault` backs the gateway provider key and the runner push token.

**Source:** [`agent/lib/dark-factory/credential-vault.ts`](../../agent/lib/dark-factory/credential-vault.ts)

**Exports:** `createInMemoryCredentialVault`, `CredentialVault`, `InMemoryCredentialVaultOptions`

**Decisions:** [ADR 0035](../../docs/adr/0035-df-sandbox-credential-vault.md)

## opensandbox-credential-vault

Dark Factory — OpenSandbox Credential Vault adapter (#282 R3). An SDK-typed backend implementing `CredentialVault` against OpenSandbox's write-only vault; `redeem` intentionally throws because the host never reads a secret back — it is injected into the sandbox via the credential proxy. Live use is gated on a vault-capable server.

**Source:** [`agent/lib/dark-factory/opensandbox-credential-vault.ts`](../../agent/lib/dark-factory/opensandbox-credential-vault.ts)

**Exports:** `createOpenSandboxCredentialVault`, `OpenSandboxVaultDeps`

**Decisions:** [ADR 0035](../../docs/adr/0035-df-sandbox-credential-vault.md)

## provider-key

Dark Factory — server-side provider-key resolver (#282 R3/T1). Issues then redeems an opaque lease so the gateway's `forwardUpstream` reads the model-provider key from the write-only vault rather than from `process.env` at request time, and never logs it.

**Source:** [`agent/lib/dark-factory/provider-key.ts`](../../agent/lib/dark-factory/provider-key.ts)

**Exports:** `resolveProviderKey`, `ProviderKeyResolverDeps`

**Decisions:** [ADR 0035](../../docs/adr/0035-df-sandbox-credential-vault.md)

## git-push

Dark Factory — secret-free git push (#282 R3/T2). Builds a bare-URL push command and supplies the token only through a `GIT_ASKPASS` helper; the authed push URL is never constructed, so the token never appears in argv, the URL, or logs.

**Source:** [`agent/lib/dark-factory/git-push.ts`](../../agent/lib/dark-factory/git-push.ts)

**Exports:** `buildGitPushCommand`, `gitPushWithVault`, `GitPushCommand`, `BuildGitPushCommandArgs`, `GitPushWithVaultArgs`

**Decisions:** [ADR 0035](../../docs/adr/0035-df-sandbox-credential-vault.md)

## local-run-preflight

Dark Factory — local-run preflight (#404 R1). Collects EVERY prerequisite problem of a local run and reports them together, so a missing variable is one block of output rather than an afternoon of refusals. A pure function of (env, target, probes): all I/O arrives through injected probes, so the chain is testable without a database, a cluster, or a network. Never prints a secret value — problems name the VARIABLE, never what is in it.

**Source:** [`agent/lib/dark-factory/local-run-preflight.ts`](../../agent/lib/dark-factory/local-run-preflight.ts)

**Exports:** `preflightLocalRun`, `PreflightProblem`, `PreflightEnv`, `PreflightProbes`, `PreflightInput`, `PreflightResult`, `PreflightProblemCode`

## local-run-checkout

Dark Factory — checkout planner (#404 R1 Task 3). Decides the per-issue workspace for the TARGET repository and how to produce it, because discovery reads `process.cwd()` (#405). The clone URL is always the clean public one; authentication travels in the git environment for the single clone invocation, so a token never reaches argv or `.git/config`. Containment uses `path.relative`, never a string prefix.

**Source:** [`agent/lib/dark-factory/local-run-checkout.ts`](../../agent/lib/dark-factory/local-run-checkout.ts)

**Exports:** `planCheckout`, `gitAuthEnv`, `CheckoutPlan`, `CheckoutPlanInput`

## local-run

Dark Factory — local-run orchestrator (#404 R1 Task 4). The testable core behind `npm run df:local-run`: runs the preflight, refuses before spawning, prepares the checkout, and runs the child. The decision and the rendering are pure; the only side effect (the spawn) is injected, so the contract holds without running a real agent. A park is printed as a park, not left as a silent hang.

**Source:** [`agent/lib/dark-factory/local-run.ts`](../../agent/lib/dark-factory/local-run.ts)

**Exports:** `buildLaunchDecision`, `renderProblems`, `runLocalRun`, `LaunchDecision`, `LaunchInput`, `LaunchSpawn`, `RunnerSpawn`, `GitClone`, `defaultGitClone`, `defaultRunnerSpawn`, `loadLauncherEnv`

## retire-claim

Dark Factory — retiring a stale claim (#404 R2). The operator's "let go" for a run that stopped without finishing: it retires the claim through the store, then reconciles the ticket's factory-owned labels — reusing the run finalizer's own `CLEARED_LABELS` set, so a retired run leaves the same label state as any other terminal transition. A refusal changes nothing: a live holder, or no claim at all, returns without a single label write. No terminal label is applied, because retiring is neither a success nor a failure.

**Source:** [`agent/lib/dark-factory/retire-claim.ts`](../../agent/lib/dark-factory/retire-claim.ts)

**Exports:** `retireStaleClaim`, `RetireReport`, `RetireOutcome`, `RetireDeps`, `RetireInput`

**Decisions:** [ADR 0051](../../docs/adr/0051-df-retiring-a-stale-claim-is-abandonment.md)


## AMM readiness

Scores a repository against the whitepaper's Autonomy Maturity Model: the eight technical pillars, the level of
each, and the binary signals behind it. Supplies the fixture scan that the web repository list renders (epic
#403 R1) and the seam the AMM scanner will fill later, so the mocked phase and the real phase share one contract.

**Source:** [`agent/lib/dark-factory/amm-readiness.ts`](../../agent/lib/dark-factory/amm-readiness.ts)

## AMM signal catalogue

The AMM model as DATA: one row per signal naming its pillar, the level that sets its point value, the automated check
that decides whether it is present, what that check must show, how to fix it when absent, and the whitepaper line it
comes from. A reviewer corrects the model here without touching the scorer, which is the whole reason it is data
rather than code (#382).

**Source:** [`agent/lib/dark-factory/amm-signals.ts`](../../agent/lib/dark-factory/amm-signals.ts)

## AMM scoring

Turns measurements into a scan: binary signals, points from the level (L1 1, L2 2, L3 4, L4 8, L5 16), and the
whitepaper's thresholds (L1 5, L2 19, L3 36, L4 60, L5 100). The score is NORMALISED over the catalogue, so
everything present is exactly 100 and nothing overshoots the top of the scale. UNMEASURED is a third state that
earns no points: a repository cannot graduate on signals nobody could measure. Also owns Organizational Readiness -
the share of active repositories at or above the production floor - so the repo list and a per-repo profile cannot
disagree about the same fleet (#382).

**Source:** [`agent/lib/dark-factory/amm-scoring.ts`](../../agent/lib/dark-factory/amm-scoring.ts)

**Exports:** `scoreRepo`, `levelForPoints`, `profileVsTarget`, `readinessOf`, `labelForLevel`, `AMM_POINT_VALUES`,
`AMM_TARGET_LEVEL`, `UNMEASURED_LABEL`

## AMM scan store

#424 - the storage seam for AMM scans, plus the local driver. A scan is APPEND-ONLY: a repeat scan is a new row, because the
series is the value and "current vs target" is just the newest one. Per-signal detail is stored as JSON while the
queryable fields (repo, tenant, scanned_at, catalogue_version, points, level) are real columns, so the list queries stay
indexed without growing the table sideways.

The signal TRIAD is the load-bearing invariant. The model distinguishes "nobody looked" from "looked, and it is
missing" - so `present` / `absent` / `unmeasured` is carried verbatim and never reduced to a boolean on the way to disk.
#426's runner is what decides those states; storing a two-state shape here would mean the schema had to be migrated the
moment the runner landed. `assertTriad` is exported and called by BOTH drivers, because enforcing it in one write path
only would leave the other accepting rows this one refuses. `comparable()` refuses a set of scans that spans two
catalogue versions, since a trend drawn across a weight change is an artifact wearing a trend's clothes (#424).

**Source:** [`agent/lib/dark-factory/amm-scan-store.ts`](../../agent/lib/dark-factory/amm-scan-store.ts)

**Exports:** `SqliteAmmScanStore`, `AmmScanStore`, `StoredAmmScan`, `AmmScanState`, `AMM_SCAN_STATES`, `toStoredScan`,
`catalogueVersion`, `scanCatalogueVersion`, `comparable`, `assertTriad`, `ammScanRowId`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## AMM scan postgres

#424 - the deployed driver for AMM scans. Same interface as the SQLite store, so the pages cannot tell them apart. It
creates its own schema with `CREATE TABLE IF NOT EXISTS` on first use, as every other Dark Factory Postgres adapter does;
RLS is enabled by migration 009 rather than by the DDL.

**Source:** [`agent/lib/dark-factory/amm-scan-postgres.ts`](../../agent/lib/dark-factory/amm-scan-postgres.ts)

**Exports:** `PostgresAmmScanStore`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

## AMM scan provider

#424 - chooses the AMM scan store and exposes it through the seam the pages already read. FAIL-CLOSED: an unconfigured
driver throws rather than falling back to the fixture or to an empty table, because an empty table renders as "no
repositories are ready" - which looks like a measurement and is not one. A read that FAILS throws too: a broken database
must not be indistinguishable from a repository nobody has scanned.

**Source:** [`agent/lib/dark-factory/amm-scan-provider.ts`](../../agent/lib/dark-factory/amm-scan-provider.ts)

**Exports:** `createAmmScanStore`, `databaseAmmProvider`, `AmmScanStoreEnv`

**Decisions:** [ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)

