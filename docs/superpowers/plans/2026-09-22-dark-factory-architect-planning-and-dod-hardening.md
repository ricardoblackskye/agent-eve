# Dark Factory: Architect Planning Stage, Multi-File Developer Agent, and AC-Traceable DoD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate false-positive completions in the Dark Factory by introducing an Architect Planning stage, equipping the Developer Agent with multi-file workspace tools, and strictly enforcing Acceptance Criteria (AC) traceability in the Definition of Done.

**Architecture:** A two-tier agent pipeline where the Architect Agent inspects the repository and generates a validated `ExecutionPlan` with an AC-to-test mapping before coding begins; a pre-flight domain validator prevents out-of-domain scope reductions; the Developer Agent uses workspace tools (`read_file`, `write_file`, `run_tests`) across multiple files; and the Definition of Done (DoD) requires an AC Traceability Matrix proving that every story criterion is backed by a passing test.

**Tech Stack:** TypeScript (ESNext/Node), Vitest, AI SDK / OpenRouter, Git, GitHub Octokit/REST API.

## Global Constraints

- **Confinement:** Tools granted to agents (`read_file`, `write_file`, `run_tests`) MUST remain sandboxed within the target repository workspace root; no access outside the working tree or to system secrets.
- **Fail-Closed:** If the Architect Agent fails to produce a valid plan after 2 self-correction cycles, the runner must exit with code 1 and record the failure without committing code.
- **Traceability Table:** The DoD coordinator must post a markdown table in the PR detailing: `| AC | Description | Test File | Test Case | Status |`.
- **Cost & Iteration Bounds:** Multi-turn tool execution remains subject to strict iteration and token caps under the Dark Factory circuit breaker.
- **Backward Compatibility:** Existing single-task Dark Factory tests in `tests/dark-factory/` must continue to pass without regression.

---

### Task 1: Execution Plan Model & Domain Validator

**Files:**
- Create: `agent/lib/dark-factory/plan-validator.ts`
- Test: `tests/dark-factory/plan-validator.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface PlanTargetFile {
    path: string;
    action: "create" | "modify";
    rationale: string;
  }

  export interface AcceptanceCriteriaTestMapping {
    acId: string;
    description: string;
    testFile: string;
    testCaseName: string;
  }

  export interface ExecutionPlan {
    storyId: number;
    title: string;
    summary: string;
    targetFiles: PlanTargetFile[];
    acceptanceCriteriaMap: AcceptanceCriteriaTestMapping[];
    dependencies?: string[];
  }

  export interface PlanValidationResult {
    valid: boolean;
    errors: string[];
  }

  export function validateExecutionPlan(
    plan: ExecutionPlan,
    storyText: string,
  ): PlanValidationResult;
  ```

- [ ] **Step 1: Write the failing unit tests for plan-validator**
Write tests covering:
1. Valid plan passing validation.
2. Plan missing target files entirely -> rejected.
3. UI/Chat story (mentioning "chat ui", "page", or "browser") that does NOT touch any file under `app/` or `components/` -> rejected with domain error.
4. Story with acceptance criteria that are missing from `acceptanceCriteriaMap` -> rejected.
5. AC mapping missing `testFile` or `testCaseName` -> rejected.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/dark-factory/plan-validator.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement plan-validator.ts**
Implement `validateExecutionPlan` with regex-based domain rules:
- Checks `storyText` for UI signals (`chat`, `ui`, `page`, `screen`, `redirect`, `browser`). If UI signals present, requires at least one `targetFiles` entry starting with `app/` or `components/`.
- Extracts AC identifiers (e.g. `AC1`, `AC2` or `given...when...then` blocks) and ensures all are mapped in `acceptanceCriteriaMap`.
- Ensures all paths in `targetFiles` are relative and do not contain `..` traversal.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run tests/dark-factory/plan-validator.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add agent/lib/dark-factory/plan-validator.ts tests/dark-factory/plan-validator.test.ts
git commit -m "feat(dark-factory): #179 add ExecutionPlan interfaces and domain validator"
```

---

### Task 2: Architect Agent (Repository Discovery & Plan Synthesis)

**Files:**
- Create: `agent/lib/dark-factory/architect-agent.ts`
- Test: `tests/dark-factory/architect-agent.test.ts`

**Interfaces:**
- Consumes: `ExecutionPlan`, `validateExecutionPlan` from `agent/lib/dark-factory/plan-validator.ts`
- Produces:
  ```typescript
  export interface ArchitectDeps {
    generateText: (prompt: string) => Promise<string>;
    listFiles: (dir: string) => Promise<string[]>;
    readFile: (path: string) => Promise<string>;
    maxPlanRetries?: number;
  }

  export interface ArchitectResult {
    ok: boolean;
    plan?: ExecutionPlan;
    retries: number;
    error?: string;
  }

  export class ArchitectAgent {
    constructor(private deps: ArchitectDeps) {}
    async planStory(story: { number: number; title: string; body: string }): Promise<ArchitectResult>;
  }
  ```

- [ ] **Step 1: Write the failing tests for architect-agent**
Write tests covering:
1. Synthesizes a valid `ExecutionPlan` given a story and repository file tree.
2. Triggers a self-correction retry when the first generated plan fails domain validation (e.g. missing UI files), passing validator feedback to the LLM.
3. Fails closed and returns `{ ok: false, error: ... }` when retries exceed `maxPlanRetries`.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/dark-factory/architect-agent.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement architect-agent.ts**
- Gathers the repository skeletal structure via `deps.listFiles`.
- Constructs prompt containing repo file list, full story title and body, and JSON schema requirements for `ExecutionPlan`.
- Parses returned JSON into `ExecutionPlan`.
- Runs `validateExecutionPlan`.
- If invalid and retries remain, feeds error list back into a repair prompt.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run tests/dark-factory/architect-agent.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add agent/lib/dark-factory/architect-agent.ts tests/dark-factory/architect-agent.test.ts
git commit -m "feat(dark-factory): #179 implement ArchitectAgent with repo discovery and self-correcting plan loop"
```

---

### Task 3: Multi-File Workspace Tool Loop in Developer Agent

**Files:**
- Modify: `agent/lib/dark-factory/developer-agent.ts`
- Test: `tests/dark-factory/developer-agent-tools.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface WorkspaceTools {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    listFiles(pattern?: string): Promise<string[]>;
    runTests(cmd?: string): Promise<{ passed: boolean; output: string }>;
  }

  export interface MultiFileCodingLoopOptions {
    plan: ExecutionPlan;
    tools: WorkspaceTools;
    worker: (ctx: LoopContext & { plan: ExecutionPlan; tools: WorkspaceTools }) => Promise<WorkerResult>;
    maxIterations: number;
  }

  export function runMultiFileCodingLoop(opts: MultiFileCodingLoopOptions): Promise<LoopResult>;
  ```

- [ ] **Step 1: Write the failing tests for multi-file workspace tools**
Write tests covering:
1. Tool path containment: `readFile` and `writeFile` throw `InvalidTaskError` if given paths outside the workspace root (e.g. `../` or `/etc/passwd`).
2. Multi-file coding loop executes iterations until `runTests` reports `passed: true`.
3. Worker can modify existing files and create new files as specified in `ExecutionPlan`.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/dark-factory/developer-agent-tools.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement runMultiFileCodingLoop and workspace tool containment**
- In `agent/lib/dark-factory/developer-agent.ts`, implement `createWorkspaceTools(workspaceDir: string)` with canonical path containment checks.
- Add `runMultiFileCodingLoop` that drives the fail-fix-pass cycle guided by `ExecutionPlan`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run tests/dark-factory/developer-agent-tools.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add agent/lib/dark-factory/developer-agent.ts tests/dark-factory/developer-agent-tools.test.ts
git commit -m "feat(dark-factory): #179 add multi-file workspace tools and bounded coding loop to DeveloperAgent"
```

---

### Task 4: Acceptance Criteria Traceability & Anti-Rubber-Stamp in Definition of Done

**Files:**
- Modify: `agent/lib/dark-factory/definition-of-done.ts`
- Test: `tests/dark-factory/definition-of-done-ac.test.ts`

**Interfaces:**
- Modify `DefinitionOfDoneTask`:
  ```typescript
  export interface DefinitionOfDoneTask {
    // ... existing fields ...
    plan?: ExecutionPlan;
  }
  ```
- Modify `DefinitionOfDoneResult`:
  ```typescript
  export interface AcTraceabilityItem {
    acId: string;
    description: string;
    testFile: string;
    testCaseName: string;
    passed: boolean;
  }

  export interface DefinitionOfDoneResult {
    // ... existing fields ...
    acMatrix?: AcTraceabilityItem[];
    traceabilitySummary?: string;
  }
  ```

- [ ] **Step 1: Write the failing tests for AC Traceability in DoD**
Write tests covering:
1. DoD fails (`ok: false`, status: `failed`) if any AC in `task.plan.acceptanceCriteriaMap` does not have a passing test.
2. DoD succeeds and generates markdown traceability table when all ACs pass.
3. Review findings with `severity: "error"` cannot be auto-accepted without explicit verification.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/dark-factory/definition-of-done-ac.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement AC Traceability in definition-of-done.ts**
- In `runDefinitionOfDone`, if `task.plan` is provided, evaluate the test results against `task.plan.acceptanceCriteriaMap`.
- Generate the markdown table:
  ```markdown
  ### Acceptance Criteria Traceability Matrix
  | AC | Description | Test File | Test Case | Status |
  |:---|:---|:---|:---|:---|
  ```
- Include this table in the durable PR comment and ensure DoD fails if any AC is unmet.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run tests/dark-factory/definition-of-done-ac.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add agent/lib/dark-factory/definition-of-done.ts tests/dark-factory/definition-of-done-ac.test.ts
git commit -m "feat(dark-factory): #179 enforce AC Traceability Matrix and anti-rubber-stamp in Definition of Done"
```

---

### Task 5: End-to-End Dark Factory Runner Integration

**Files:**
- Modify: `scripts/dark-factory-runner.ts`
- Test: `tests/dark-factory/dark-factory-e2e-integration.test.ts`

- [ ] **Step 1: Write integration tests for runner stages**
Test that `dark-factory-runner` components wire together:
- Issue fetch -> Architect Agent planning -> Domain validation -> Multi-file Developer Agent loop -> DoD with AC Traceability Matrix.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/dark-factory/dark-factory-e2e-integration.test.ts`  
Expected: FAIL

- [ ] **Step 3: Update scripts/dark-factory-runner.ts**
- Replace hardcoded single-file JSON prompt with:
  1. `architectAgent.planStory(issueData)`.
  2. Domain validation check with retry on failure.
  3. Workspace tools dispatching developer agent across target files.
  4. Passing `plan` to `runDefinitionOfDone` to post the AC Traceability Matrix.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run tests/dark-factory/dark-factory-e2e-integration.test.ts`  
Expected: PASS

- [ ] **Step 5: Run full project test suite to verify no regressions**
Run: `npm test`  
Expected: All tests PASS

- [ ] **Step 6: Commit**
```bash
git add scripts/dark-factory-runner.ts tests/dark-factory/dark-factory-e2e-integration.test.ts
git commit -m "feat(dark-factory): #179 wire ArchitectAgent, multi-file loop, and AC Traceability into dark-factory-runner"
```

---

## Plan Self-Review Checklist

- **Spec Coverage:**
  - AC1 (Architect Planning & Discovery) -> Task 2
  - AC2 (Pre-Code Domain Validation) -> Task 1
  - AC3 (Multi-File Developer Agent) -> Task 3
  - AC4 (AC Traceability in DoD) -> Task 4
  - AC5 (Eliminate Rubber-Stamp Auto-Dispositioning) -> Task 4
  - End-to-End Runner Integration -> Task 5
- **Placeholder Scan:** No "TBD", "TODO", or vague implementation stubs.
- **Type Consistency:** `ExecutionPlan`, `PlanTargetFile`, `AcceptanceCriteriaTestMapping`, and `AcTraceabilityItem` types match across all 5 tasks.
