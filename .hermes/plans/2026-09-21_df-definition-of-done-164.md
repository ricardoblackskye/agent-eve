# #164 — definition of DONE (PR opened, review findings resolved or accepted, bounded loop)

**Branch:** `feat/dark-factory-R5-definition-of-done` (from `origin/main` = `a67b143`, which includes #163 via PR #172 and #173 via PR #174)
**Issue:** #164 · **Release:** R5 — closes Release 5 of Dark Factory

## The gap, re-verified

Currently, the Developer Agent (`agent/lib/dark-factory/developer-agent.ts`) terminates when its sandboxed unit tests pass (AC5). Beyond that, there is **no path** connecting a finished worker task to:
1. Opening a **pull request** linked to the issue (`Closes #<issue>`),
2. Ingesting and dispositioning **automated review findings** (PR reviewer, CodeQL, linters, tests), or
3. Enforcing a bounded review→fix loop that stops at `df:blocked` on budget exhaustion rather than spinning indefinitely.

The pieces exist in isolation:
- `scripts/pr-reviewer.js` posts review feedback on PRs.
- `agent/lib/dark-factory/issue-writer.ts` provides token-injected GitHub comment & label primitives.
- `agent/lib/dark-factory/worker-reporter.ts` handles status updates and the `blocked` / `needs-answer` park step (#162).
- `agent/lib/dark-factory/credentials.ts` enforces fail-closed `DF_WORKER_ALLOWED_REPOS`.
- `agent/lib/dark-factory/circuit-breaker.ts` guards iteration and cost budgets (#144).

#164 ties these components into a concrete, bounded **Definition of DONE**.

---

## REVIEW findings & Architectural Decisions

### 1. Opening the PR is the terminal automated action — NEVER merge
Merging is strictly reserved for the human operator. The orchestrator opens the PR on the task branch, links it to the issue via `Closes #<issue>`, and terminates after all findings are dispositioned. No code path may invoke GitHub's merge API (`PUT /repos/{owner}/{repo}/pulls/{number}/merge`).

### 2. Dual disposition paths for automated review findings
Every finding generated across review rounds must be explicitly accounted for:
- **`resolved`**: Fixed by a subsequent code change in the workspace/branch.
- **`accepted`**: Deemed acceptable or non-blocking, accompanied by a **durable, reasoned explanation** posted directly as a PR comment.
A task CANNOT reach `done` if any finding remains unaddressed (neither resolved nor accepted).

### 3. Bounded review→fix loop with no reset on recurrence
To prevent infinite review cycles and token exhaustion:
- Bounded by `DF_MAX_REVIEW_ROUNDS` (digits-only, default `3`).
- Malformed config (`"1e3"`, `"-1"`, `"0"`, `"abc"`) throws an error fail-closed (matching `DF_MAX_ITERATIONS`).
- **Recurring findings do NOT reset the budget**: if finding F1 recurs in round 2, it increments its recurrence counter and consumes round 2 of the budget.
- When `DF_MAX_REVIEW_ROUNDS` is exhausted with unresolved/unaccepted findings remaining, the run halts immediately, transitions to `blocked`, adds label `needs-answer`, and requests human intervention.

### 4. Attribution and auditability of acceptance
As agreed with the Product Owner (18/09):
- The Developer Agent drafts the rationale for accepted findings in a structured PR comment.
- The human reviewer validates this rationale at merge time.
- Acceptance reasoning is posted to GitHub comments on the PR itself (not buried in ephemeral logs or state stores).

### 5. Seam isolation for local offline testing
All GitHub API interactions (PR creation, review finding retrieval, PR commenting) must use an injectable transport interface (`fetchImpl` or mock provider) so that the entire definition-of-done loop can be tested deterministically offline without network calls or live GitHub credentials.

---

## Design

### 1. Data Structures & Types (`agent/lib/dark-factory/definition-of-done.ts`)

```typescript
export type FindingSource = "pr-reviewer" | "codeql" | "linter" | "test";
export type FindingDispositionStatus = "resolved" | "accepted";

export interface ReviewFinding {
  id: string;
  source: FindingSource;
  message: string;
  file?: string;
  line?: number;
  severity?: "error" | "warning" | "note";
}

export interface FindingDisposition {
  findingId: string;
  status: FindingDispositionStatus;
  explanation?: string; // Required when status === "accepted"
}

export interface ReviewRoundState {
  round: number;
  maxRounds: number;
  findings: ReviewFinding[];
  dispositions: FindingDisposition[];
  recurrenceMap: Record<string, number>;
}

export interface PullRequestDetails {
  number: number;
  url: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export type DoneStatus = "done" | "blocked" | "refused";

export interface DefinitionOfDoneResult {
  ok: boolean;
  status: DoneStatus;
  pr?: PullRequestDetails;
  roundsExecuted: number;
  totalFindings: number;
  resolvedCount: number;
  acceptedCount: number;
  remainingFindings: ReviewFinding[];
  reason: string;
}
```

### 2. PR Opener Seam (`agent/lib/dark-factory/pr-writer.ts`)
Extends or complements `GitHubIssueWriter` to support PR creation:
- `createPullRequest(owner, repo, { title, head, base, body })`: calls `POST /repos/{owner}/{repo}/pulls`.
- Fails closed if `repo` is not in `DF_WORKER_ALLOWED_REPOS`.
- Injected `fetchImpl` for testing.
- Strictly omits any merge endpoints.

### 3. Review & Fix Coordinator (`runDefinitionOfDone`)
Takes:
- Task information (issue number, repo, task branch, commit ref)
- Injected checkers/reviewers (returning `ReviewFinding[]`)
- Injected fixer / agent (attempting code fix or returning acceptance rationale)
- Injected PR writer / reporter
Executes:
1. Opens PR linked to issue (`Closes #${issue}`).
2. Loops `round = 1..maxRounds`:
   a. Collects findings.
   b. Tracks recurrences in `recurrenceMap`.
   c. Dispositions findings (code fix vs. accepted with rationale).
   d. For accepted findings: posts durable explanation comment to PR.
   e. If all findings resolved or accepted: return `{ status: "done", pr, ... }`.
3. If loop exits with remaining findings:
   - Halts and returns `{ status: "blocked", reason: "review budget exhausted", ... }`.
   - Labels issue with `needs-answer`.

---

## Tasks (RED → GREEN TDD Cycles)

| Cycle | RED (Failing Test) | GREEN (Implementation) |
|:-----:|:-------------------|:-----------------------|
| **1** | `resolveMaxReviewRounds` throws `InvalidConfigurationError` on malformed (`"1e3"`, `"-1"`, `"0"`, `"abc"`, `""`), returns parsed int for digits, defaults to 3 | Digits-only config validation regex `/^\d+$/` matching `DF_MAX_ITERATIONS` |
| **2** | `createPullRequest` creates PR with `Closes #<issue>`, enforces `DF_WORKER_ALLOWED_REPOS` fail-closed, returns PR number and URL | Pure PR creation client with injected fetch |
| **3** | Clean run: worker finishes with 0 findings → opens PR, marks `done` with PR link immediately | Initial loop pass on empty findings |
| **4** | Code fix: worker encounters findings, fixes them in round 2 → marks `done` in round 2 | Multi-round resolution logic |
| **5** | Finding accepted: worker accepts finding with rationale → posts structured explanation comment to PR | PR comment formatter and dispatcher for accepted findings |
| **6** | Acceptance without rationale is REFUSED | Validation requiring non-empty `explanation` for accepted dispositions |
| **7** | Recurring findings count against budget without resetting round counter | Recurrence tracker and cumulative budget enforcement |
| **8** | Budget exhaustion: findings remain after `DF_MAX_REVIEW_ROUNDS` → halts, transitions to `blocked`, labels `needs-answer` | Halting logic on round limit with blocked status |
| **9** | Auditability: PR comment contains visible, attributable explanation for each accepted finding | Markdown template verifying attributed Eve header and human reviewer disclaimer |
| **10** | Non-merge invariant: asserts that no code or dependency invokes GitHub merge API | Static and runtime boundary guarantee ensuring PR is never merged |

---

## Verification Plan

### Automated Tests
1. **Unit & Integration Suite**:
   ```powershell
   npx vitest run tests/dark-factory/definition-of-done.test.ts
   ```
   - Covers all 10 TDD cycles.
2. **Regression Suite**:
   ```powershell
   npx vitest run tests/dark-factory/
   ```
   - Asserts all existing 610 Dark Factory tests pass without regression.
3. **Typecheck & Linter**:
   ```powershell
   npm run typecheck
   ```

---

## Status

**Awaiting user review of this plan.** No source code has been modified on this branch beyond this document.
