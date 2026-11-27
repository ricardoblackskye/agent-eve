/**
 * Dark Factory — Autonomous Developer Agent End-to-End Runner (#179).
 *
 * Runs the full hardened Dark Factory pipeline autonomously for a GitHub issue:
 * 1. Reads the live User Story from GitHub Issue.
 * 2. Moves ticket lifecycle label to `df:running` and posts progress comment.
 * 3. Architect Agent explores repo structure & synthesizes an ExecutionPlan.
 * 4. Pre-flight domain validator validates target files against story domain.
 * 5. Multi-file Developer Agent operates via sandboxed workspace tools (read/write/test) across files.
 * 6. Executes Definition of DONE with Acceptance Criteria (AC) Traceability verification and anti-rubber-stamp.
 * 7. Opens PR, posts AC Traceability Matrix, transitions ticket to `df:done`, and verifies non-merge.
 *
 * Run: npx tsx scripts/dark-factory-runner.ts [--issue <num>] [--branch <name>]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, execSync } from "node:child_process";
import { loadLocalEnv } from "./load-env";
import { streamText } from "ai";
import { resolveChatModelWithId } from "../agent/chat-model";
import { initRunnerEnv } from "../agent/lib/dark-factory/runner-env";
import {
  createWorkspaceReader,
  resolvePlanWorkspace,
  resolveWorkspaceOverride,
} from "../agent/lib/dark-factory/plan-workspace";
import {

  runDefinitionOfDone,
  type DefinitionOfDoneDeps,
  type DefinitionOfDoneTask,
  type ReviewFinding,
  type PrCheckAnnotation,
  type PrCheckRun,
  type PrOpener,
  checkRunFindings,
  settlePullRequestChecks,
  type DefinitionOfDoneResult,

  CHECKS_NOT_FINISHED,} from "../agent/lib/dark-factory/definition-of-done";
import {
  applyStartLifecycle,
  applyTerminalLifecycle,
  isWaitingOnChecks,
} from "../agent/lib/dark-factory/run-finalizer";
import { renderSignOffComment } from "../agent/lib/dark-factory/dod-presentation";
import { GitHubPrWriter } from "../agent/lib/dark-factory/pr-writer";
import {
  GitHubIssueWriter,
  createGitHubLabelWriter,
  resolveIssueToken,
} from "../agent/lib/dark-factory/issue-writer";
import { resolveWorkerAllowedRepos } from "../agent/lib/dark-factory/credentials";
import {
  authorizeTargetRepo,
  loadRunnerConfig,
  resolveBranchName,
  resolveIssueNumber,
  resolveTargetRepo,
} from "../agent/lib/dark-factory/runner-config";
import { createInMemoryCredentialVault } from "../agent/lib/dark-factory/credential-vault";
import {
  commitAndPushFromSandbox,
  ensureSandboxRepo,
  gitPushWithVault,
  type SandboxGitRunner,
} from "../agent/lib/dark-factory/git-push";
import { DEFAULT_SANDBOX_WORKSPACE } from "../agent/lib/dark-factory/opensandbox-driver";
import { resolvePrChecksTimeoutMs } from "../agent/lib/dark-factory/pr-checks-timeout";
import {
  artefactIdentity,
  checkOutcomeLines,
  checkSetSummary,
  decideGate,
  formatTestVerdict,
  resolveE2eCommand,
  resolveLintCommands,
  CircuitTrippedError,
  DeveloperAgent,
  runMultiFileCodingLoop,
  toTaskAssignment,
  type LoopResult,
  workspaceCommandsFor,
} from "../agent/lib/dark-factory/developer-agent";
import {
  createCircuitBreaker,
  type TripEvent,
} from "../agent/lib/dark-factory/circuit-breaker";
import { createSandboxProvider } from "../agent/lib/dark-factory/sandbox-provider";
import { reapSandboxesByRun } from "../agent/lib/dark-factory/sandbox-reaper";
import type { SandboxProvider } from "../agent/lib/dark-factory/sandbox";
import {
  createFixCycle,
  type AttemptFixes,
} from "../agent/lib/dark-factory/fix-cycle";
import type { WorkspaceTools } from "../agent/lib/dark-factory/developer-agent";
import { createCodeAuthorProvider } from "../agent/lib/dark-factory/code-author-provider";
import {
  assessPreservation,
  type PlanFileAction,
} from "../agent/lib/dark-factory/preservation-guard";
import { renderPlanFile } from "../agent/lib/dark-factory/plan-file";
import { postPlanComment } from "../agent/lib/dark-factory/plan-comment";
import { estimatePlanCostSafely } from "../agent/lib/dark-factory/plan-cost-estimate";
import { estimateCost, resolvePrice } from "../agent/lib/dark-factory/cost-budget";
import { createWorkerUsageRecorder } from "../agent/lib/dark-factory/worker-usage";
import { recordPlanWithEstimateSafely } from "../agent/lib/dark-factory/plan-estimate-recorder";
import {
  explainPlanFailure,
  loadApprovedPlan,
  parkForApproval,
  PLAN_INVALID_QUESTION,
  TARGET_UNRESOLVED_QUESTION,
} from "../agent/lib/dark-factory/plan-approval";
import {
  MAX_PLAN_REVISIONS_ENV,
  classifyPlanResponse,
  resolveMaxPlanRevisions,
} from "../agent/lib/dark-factory/plan-response";
import {
  isPlanRevisionCapReached,
  readPlanRevisionCount,
  recordPlanRevision,
  recordRunResumed,
} from "../agent/lib/dark-factory/plan-revision-recorder";
import { resolveRunnerAnswer } from "../agent/lib/dark-factory/runner-config";
import { createWorkerReporter } from "../agent/lib/dark-factory/worker-reporter";
import { resolveAgentOutputRecorder } from "../agent/lib/dark-factory/agent-output";
import { createStateStore } from "../agent/lib/dark-factory/state-provider";
import { TRIGGER_LABELS } from "../agent/lib/dark-factory/trigger";
import type { CodeAuthorProvider } from "../agent/lib/dark-factory/code-author";
import { createCodingLoopBreaker } from "../agent/lib/dark-factory/breaker-wiring";
import { recordBreakerTrip } from "../agent/lib/dark-factory/breaker-trip-recorder";
import { createMetricsStore } from "../agent/lib/dark-factory/metrics";
import {
  ArchitectAgent,
  resolveArchitectTimeoutMs,
} from "../agent/lib/dark-factory/architect-agent";
import {
  validateExecutionPlan,
  type ExecutionPlan,
} from "../agent/lib/dark-factory/plan-validator";
import { createControlStore } from "../agent/lib/dark-factory/control";
import { createControlCheckpoint } from "../agent/lib/dark-factory/control-checkpoint";
import type { ControlStore } from "../agent/lib/dark-factory/control";
import {
  createCostBudgetStore,
  isCostGovernanceConfigured,
} from "../agent/lib/dark-factory/cost-budget-store";
import {
  utcMonth, createCostGovernor } from "../agent/lib/dark-factory/cost-governor";
import { createRunHistoryStore } from "../agent/lib/dark-factory/run-history-provider";
import {
  beginRunRecord,
  decideRunStart,
} from "../agent/lib/dark-factory/run-record";
import { withNotifications } from "../agent/lib/dark-factory/notifying-run-history";
import { runGovernedAgentCall } from "../agent/lib/dark-factory/governed-agent-call";
import { recordRunActualCost } from "../agent/lib/dark-factory/run-cost-recorder";
import {
  attemptRecordingDecision,
  buildAttemptSummary,
} from "../agent/lib/dark-factory/run-attempt-summary";
import type { RunStatus } from "../agent/lib/dark-factory/run-history";
import { createUsageStore } from "../agent/lib/dark-factory/usage-store-provider";
import {
  FINISHED_RUN_STATUSES,
  PLAN_HISTORY_WINDOW,
  selectPlanHistory,
} from "../agent/lib/dark-factory/plan-history";
import type { RunSummary } from "../agent/lib/dark-factory/run-history";
import type { RunHistoryStore } from "../agent/lib/dark-factory/run-history-store";
import { recordRunDiffWithOutcome, type GitRunner } from "../agent/lib/dark-factory/diff-capture";
import { parseExecutedTestCases } from "../agent/lib/dark-factory/test-case-evidence";
import { pathsOutsideApprovedSet } from "../agent/lib/dark-factory/approved-target-set";

// The .env bootstrap lives in runner-env.ts so it can be tested without running the pipeline.
// It carries NO model default: agent/model-config.ts is the single source of truth (#400).
initRunnerEnv();

const line = (label: string, value: unknown) =>
  console.log(
    `  ${label.padEnd(32)} ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );

/**
 * The plan summary lines, rendered from a plan that may be INCOMPLETE (#501).
 *
 * Display must never assert on plan shape. This ran as three inline `line(...)` calls until a real run
 * died on one of them: the architect's self-correction loop replaced a plan that carried
 * `acceptanceCriteriaMap` with one that did not, and `executionPlan.acceptanceCriteriaMap.length` aborted
 * the run at STEP 3.5 - before the plan comment, before the ledger write, before the park.
 *
 * A cosmetic line is the wrong place to enforce completeness; `validateExecutionPlan` is. Refusing a plan
 * that maps no acceptance criteria is issue #502.
 */
export interface PlanSummaryLine {
  label: string;
  value: string;
}

export function planSummaryLines(plan: {
  summary?: string | null | undefined;
  targetFiles?: ReadonlyArray<{ path?: string | undefined }> | null | undefined;
  acceptanceCriteriaMap?: ReadonlyArray<unknown> | null | undefined;
}): PlanSummaryLine[] {
  const summary =
    typeof plan?.summary === "string" && plan.summary.trim() !== "" ? plan.summary : "(none)";

  const targetFiles = Array.isArray(plan?.targetFiles)
    ? plan.targetFiles.map((entry) =>
        typeof entry?.path === "string" && entry.path !== "" ? entry.path : "(unknown path)",
      )
    : [];

  // An absent mapping list and an empty one are DIFFERENT facts: "none supplied" means the plan never
  // said how its acceptance criteria would be verified, "0" means it said there are none. Neither is
  // refused here - refusing a plan that maps nothing is validateExecutionPlan's job (#502).
  const mappings = plan?.acceptanceCriteriaMap;
  const mappingCount = Array.isArray(mappings) ? String(mappings.length) : "none supplied";

  return [
    { label: "Plan Summary", value: summary },
    { label: "Target Files", value: targetFiles.length > 0 ? targetFiles.join(", ") : "(none)" },
    { label: "AC Mappings Count", value: mappingCount },
  ];
}

/**
 * The `origin` of a checkout, or null when the directory is not one (#405).
 *
 * `execFileSync` rather than a shell string: the path comes from the operator and must never be
 * parsed by a shell.
 */
function readOriginRemote(dir: string): string | null {
  try {
    const url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return url === "" ? null : url;
  } catch {
    return null;
  }
}

let activeControlStore: ControlStore | null = null;

/**
 * #503 AC5 — the run this process currently owns, so an abort that escapes `main` can release its claim.
 *
 * `main` has no outer try: the entry-point catch only logged and closed the control store, so a throw
 * after the run was accepted (the STEP 5 render crash included) left the issue on `df:running` and the
 * ledger holding a claim no later attempt could adopt — which is why two runs in a row needed manual
 * retirement. Set once the run record is adopted; the label writer is attached when it exists.
 */
type ActiveRun = {
  repo: string;
  issue: number;
  runId: string;
  /**
   * #681: explicitly `false` when the ledger never minted a run for this attempt - it was unreachable,
   * so `beginRunRecord` reported `fellBack` and every later write targets an id the ledger has never
   * heard of. The run still happened, so it is recorded as its own terminal row at the end.
   *
   * Optional on purpose: absent means "do not record", so a caller that does not know cannot cause a
   * write. Only an explicit `false` does.
   */
  ledgerRecorded?: boolean;
  /** When this attempt began, for the row recorded when the ledger has none (#681). */
  startedAt?: string;
  runHistory: Parameters<typeof applyTerminalLifecycle>[0]["runHistory"];
  labelWriter?: Parameters<typeof applyTerminalLifecycle>[0]["labelWriter"];
};

let activeRun: ActiveRun | null = null;

/**
 * Build the cooperative control checkpoint used by a runner execution.
 * Returns the backing store (for operator actions) and the checkpoint callable
 * that the Architect and Developer loops must invoke before each LLM call.
 */
export function buildRunControl(
  env: Record<string, string | undefined>,
  runId: string,
): { store: ControlStore; checkpoint: () => Promise<void> } {
  const store = createControlStore(env);
  return { store, checkpoint: createControlCheckpoint(store, runId) };
}

export function resolveRunnerRunId(
  argv: string[],
  issueNum: number,
  now = Date.now(),
): string {
  const index = argv.indexOf("--run-id");
  return index !== -1 && argv[index + 1]
    ? argv[index + 1]
    : `run-${issueNum}-${now}`;
}

/** How long a single review round waits for checks that are still running, and how often it looks (#659). */
const PR_CHECKS_TIMEOUT_MS = resolvePrChecksTimeoutMs();
const PR_CHECKS_POLL_INTERVAL_MS = 15_000;

/** The pull request the Definition of Done opened, so the check gate can read it (#659). */

/**
 * Read the check runs on a pull request's CURRENT head.
 *
 * Returns null rather than throwing when anything goes wrong, because "we could not read the checks" has
 * to stay distinguishable from "the checks passed" (#659): the mapping turns null into a warning, never
 * into a silent pass.
 */
export function makePullRequestCheckFetcher(deps: {
  token: string;
  repo: string;
  prNumber: number;
}): () => Promise<PrCheckRun[] | null> {
  const headers = {
    Authorization: `token ${deps.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "dark-factory-runner",
  };

  return async () => {
    try {
      const prResponse = await fetch(
        `https://api.github.com/repos/${deps.repo}/pulls/${deps.prNumber}`,
        { headers },
      );
      if (!prResponse.ok) return null;
      const pr = (await prResponse.json()) as { head?: { sha?: string } };
      const sha = pr.head?.sha;
      if (!sha) return null;

      // By head SHA rather than by PR: a fix pushed during the review loop moves the head, and reading the
      // older head's verdict would certify code that is no longer there.
      const checksResponse = await fetch(
        `https://api.github.com/repos/${deps.repo}/commits/${sha}/check-runs`,
        { headers },
      );
      if (!checksResponse.ok) return null;
      const body = (await checksResponse.json()) as {
        check_runs?: (PrCheckRun & {
          output?: { annotations_url?: string; annotations_count?: number };
        })[];
      };
      if (!Array.isArray(body.check_runs)) return null;

      // #718: a failing check says WHERE it failed through its annotations, and this endpoint returns
      // an `annotations_url` rather than the annotations themselves - so this is a second call, made
      // only for a check that actually annotated. Best-effort on purpose: losing the detail must not
      // lose the verdict, because a failed check that vanished from the findings would be worse than
      // one that arrives without a file.
      return await Promise.all(
        body.check_runs.map(async (run) => {
          const { output, ...check } = run;
          const annotationsUrl = output?.annotations_url;
          const annotated =
            typeof output?.annotations_count === "number" && output.annotations_count > 0;
          if (!annotated || typeof annotationsUrl !== "string" || annotationsUrl === "") {
            return check;
          }
          try {
            const response = await fetch(annotationsUrl, { headers });
            if (!response.ok) return check;
            const annotations = (await response.json()) as PrCheckAnnotation[];
            return Array.isArray(annotations) ? { ...check, annotations } : check;
          } catch {
            return check;
          }
        }),
      );
    } catch {
      return null;
    }
  };
}

async function main(): Promise<void> {
  console.log(
    "################################################################################",
  );
  console.log(
    "  DARK FACTORY: HARDENED ARCHITECT & MULTI-FILE DEVELOPER RUNNER (#179)        ",
  );
  console.log(
    "################################################################################\n",
  );

  // #404 R1 Task 5: load the agent's .env.local before env is read, so a direct `tsx scripts/dark-factory-runner.ts`
  // sees the same variables the launcher provides. `loadLocalEnv` never overrides a value the shell already set,
  // so an explicit export stays authoritative; the launcher does the equivalent in dark-factory-local-run.ts.
  loadLocalEnv();

  const env = initRunnerEnv();
  const token = resolveIssueToken(env);
  const allowed = resolveWorkerAllowedRepos(env);
  // #348: RESOLUTION and AUTHORIZATION are separate questions, answered in runner-config.ts.
  //
  // Resolution: which repository this run is for - the dispatch's `--repo`, else `default_repo` from
  // dark-factory.config.json, else a refusal. Never a literal here: a default in code is indistinguishable
  // from a hardcode, which is precisely what this issue exists to remove.
  const configResult = loadRunnerConfig();
  if (!configResult.ok) {
    throw new Error(`Dark Factory Runner cannot start: ${configResult.error}`);
  }
  const repoResult = resolveTargetRepo({
    argv: process.argv,
    config: configResult.config,
  });
  if (!repoResult.ok) {
    throw new Error(`Dark Factory Runner cannot start: ${repoResult.error}`);
  }
  const targetRepo = repoResult.repo;

  // Authorization: may we touch it? Fail-closed and BEFORE anything is cloned or written, so an
  // unconfigured or unlisted repository produces an explanation rather than a half-finished run.
  const authorization = authorizeTargetRepo({ repo: targetRepo, allowed });
  if (!authorization.ok) {
    throw new Error(`Dark Factory Runner cannot start: ${authorization.error}`);
  }

  const [repoOwner, repoName] = targetRepo.split("/");

  // #348: the issue and the branch are supplied, not invented. `--issue` used to default to 179 (a run
  // against an issue nobody asked for) and the branch to a name containing a '#', which breaks GitHub
  // URLs. Both resolve BEFORE the run record is opened, so a bad argument fails with no side effects.
  const issueResult = resolveIssueNumber(process.argv);
  if (!issueResult.ok) {
    throw new Error(`Dark Factory Runner cannot start: ${issueResult.error}`);
  }
  const issueNum = issueResult.issue;

  const branchResult = resolveBranchName({ argv: process.argv, issue: issueNum });
  if (!branchResult.ok) {
    throw new Error(`Dark Factory Runner cannot start: ${branchResult.error}`);
  }
  const branchName = branchResult.branch;

  const attemptId = resolveRunnerRunId(process.argv, issueNum);

  // #316: open the run's record FIRST, through the existing seam, and adopt the id the ledger
  // mints. The LEDGER owns run identity — it is idempotent per delivery, so re-running the same
  // attempt is a no-op — and adopting its id is what makes the run appear in the dashboard and
  // addressable by its control actions. An unconfigured ledger is reported loudly and the attempt
  // id is used as a fallback, so a local run still works.
  const runHistory = withNotifications(createRunHistoryStore(env), env);
  const isResume = process.argv.includes("--resume");

  // #378: on a resume the human's REPLY decides. The reply is read from a file rather than an argument
  // value, and a named file that cannot be read REFUSES here - it must never be degraded to "no answer",
  // which is how a cleared label is read, i.e. an approval.
  const answerResult = resolveRunnerAnswer({
    argv: process.argv,
    readFile: (answerPath) => readFileSync(answerPath, "utf8"),
  });
  if (!answerResult.ok) {
    console.error(`[ERROR] ${answerResult.error}`);
    throw new Error("Dark Factory Runner stopped after the preceding error.");
  }

  // A resume with NO reply means the `needs-answer` label was cleared, which the parked question
  // advertises as a way to begin - so it stays an approval. A resume WITH a reply is classified, and
  // only explicit approval wording counts as one.
  const planResponse =
    isResume && answerResult.answer !== undefined
      ? classifyPlanResponse(answerResult.answer)
      : undefined;
  const isRevision = planResponse?.kind === "revision";
  if (planResponse) {
    console.log(`\n[REPLY] ${planResponse.reason}`);
  }

  // #405: resolved BEFORE the run claims the issue. A refusal here must not mint a claim:
  // the top-level catch has no path that retires a run, so refusing afterwards would leave
  // the issue claimed by a run that can never plan - the #375 deadlock.
  // #405: planning reads a checkout, so the checkout is resolved deliberately and REFUSED when it
  // cannot be shown to be the target. The Architect no longer infers its root from process.cwd().
  const workspaceResult = resolvePlanWorkspace({
    targetRepo,
    cwd: process.cwd(),
    override: resolveWorkspaceOverride(process.argv, env),
    remoteOf: readOriginRemote,
  });
  if (!workspaceResult.ok) {
    console.error("[ERROR] The plan workspace cannot be used:");
    for (const problem of workspaceResult.problems) {
      console.error(problem === "" ? "" : `  ${problem}`);
    }
    throw new Error("Dark Factory Runner stopped after the preceding error.");
  }
  const planWorkspace = workspaceResult.path;

  const begun = await beginRunRecord({
    resuming: isResume,
    history: runHistory,
    attemptId,
    repo: targetRepo,
    issue: issueNum,
  });
  // #373: a run the ledger refused because ANOTHER run holds this issue must not start. The previous
  // behavior carried on with the attempt id as a synthetic run id, so its lifecycle writes targeted a run
  // the ledger had never minted - the stale claim kept the issue and nothing could release it.
  // #373: a FRESH run refused because another run holds this issue must not start. The old behavior
  // carried on with the attempt id as a synthetic run id, so its writes targeted a run the ledger had
  // never minted and the claim could never be released. A RESUME is different: the blocked holder IS the
  // run being approved, so it is adopted and the writes land on the real run.
  const startDecision = decideRunStart(begun, { resuming: isResume });
  if (startDecision.kind === "refuse") {
    throw new Error(startDecision.reason);
  }
  if (startDecision.kind === "adopt") {
    console.log(
      `\n[RESUME] Continuing the parked run ${startDecision.runId}.`,
    );
  }

  const runId = startDecision.runId;
  // #503 AC5: from here the run owns the issue's claim, so an abort that escapes `main` must release it.
  // Set BEFORE the control store and label writer exist, and filled in as they do.
  activeRun = {
    repo: targetRepo,
    issue: issueNum,
    runId,
    ledgerRecorded: begun.recorded,
    startedAt: new Date().toISOString(),
    runHistory,
  };

  const { store: runControlStore, checkpoint } = buildRunControl(env, runId);
  activeControlStore = runControlStore;
  await checkpoint();

  const { model, modelId } = resolveChatModelWithId();

  line("Target Repository", `${targetRepo} (from ${repoResult.source})`);
  line("Allowed Repositories", allowed);
  line("Target Issue", `#${issueNum}`);
  line("Plan Workspace", `${planWorkspace} (from ${workspaceResult.source})`);
  line("Configured Chat Model", modelId);
  line("GitHub Token Present?", Boolean(token));
  line("OpenRouter Key Present?", Boolean(env.OPENROUTER_API_KEY));

  if (!token || !env.OPENROUTER_API_KEY) {
    console.error(
      "[ERROR] Missing GITHUB_TOKEN or OPENROUTER_API_KEY in environment or .env",
    );
    throw new Error("Dark Factory Runner stopped after the preceding error.");
  }

  const issueWriter = new GitHubIssueWriter({ token });
  const labelWriter = createGitHubLabelWriter(issueWriter);
  // #503 AC5: attach the label writer so the abort path can apply the terminal lifecycle.
  if (activeRun) activeRun.labelWriter = labelWriter;
  const prWriter = new GitHubPrWriter({ token, env });
  const metrics = createMetricsStore();
  const developerAgent = new DeveloperAgent({ metrics });

  // Cost governance (#270): OPT-IN — `null` unless a budget backend is configured.
  const governor = isCostGovernanceConfigured(env)
    ? createCostGovernor(createCostBudgetStore(env), env)
    : null;

  // STEP 1: Fetch live issue from GitHub
  console.log(
    `\n[STEP 1] Fetching live User Story #${issueNum} from GitHub...`,
  );
  const issueRes = await fetch(
    `https://api.github.com/repos/${targetRepo}/issues/${issueNum}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "Dark-Factory-Runner",
      },
    },
  );
  if (!issueRes.ok) {
    console.error(
      `Failed to fetch issue #${issueNum}: HTTP ${issueRes.status}`,
    );
    throw new Error("Dark Factory Runner stopped after the preceding error.");
  }
  // #759: the issue payload already carries the labels; declaring them is what makes the delivered
  // state reachable at the call site without adding a reader.
  const issueData = (await issueRes.json()) as {
    title: string;
    body: string;
    labels?: { name: string }[];
  };
  line("Story Title", issueData.title);
  console.log(`  Story Length: ${issueData.body.length} characters`);

  // STEP 2: Move issue lifecycle label to df:running & post progress
  console.log(
    `\n[STEP 2] Updating ticket lifecycle label to 'df:running' and posting progress comment...`,
  );
  // #373: clear the previous attempt's terminal label first. A run that died left `df:failed` behind, and
  // adding `df:running` beside it made the ticket advertise two contradictory outcomes at once.
  const startLifecycle = await applyStartLifecycle(
    { labelWriter },
    { repo: targetRepo, issue: issueNum, existingLabels: (issueData.labels ?? []).map((l) => l.name) },
  );
  if (startLifecycle.refused) {
    // A refusal, not a fault: the run stops before the dispatch comment, so a delivered ticket is
    // never told a new process is starting - which is the report this change answers.
    console.warn(`[REFUSED] ${startLifecycle.refused}`);
    throw new Error(`Dark Factory Runner refused to dispatch: ${startLifecycle.refused}`);
  }
  if (!startLifecycle.applied) {
    console.warn(
      `[WARN] The ticket lifecycle could not be set up cleanly: ${startLifecycle.error ?? "unknown error"}`,
    );
  }
  console.log(`  -> Cleared: ${startLifecycle.cleared.join(", ") || "nothing to clear"}`);
  await issueWriter.postComment(
    repoOwner,
    repoName,
    issueNum,
    `🤖 **Eve** (Dark Factory) — Dispatched Hardened Pipeline on #${issueNum}\n\n` +
      `- **Task Branch**: \`${branchName}\`\n` +
      `- **Assigned Agents**: Architect Agent & Multi-File Developer Agent (Model: \`${modelId}\`)\n` +
      `- **Status**: Synthesizing ExecutionPlan and running pre-flight domain validation...`,
  );

  // #280: the execution backend is configuration-selected. Unset DF_SANDBOX_DRIVER = the local
  // filesystem, i.e. today's behavior; an unknown value throws before any side effect.
  // #281 (R2b/B2): the sandbox is created once per run and force-disposed by runCodingPhase,
  // so the runner owns the lifecycle (closing the SDK client does not terminate a sandbox).

  // #281 (R2b/B1): the author is configuration-selected. Unset DF_CODE_AUTHOR = in-process, i.e. the
  // governed path above, unchanged. The in-process adapter calls `generate`, which runs through the
  // cost gate, so the seam cannot bypass governance.
  const codeAuthor = createCodeAuthorProvider(
    {
      DF_CODE_AUTHOR: process.env.DF_CODE_AUTHOR,
      DF_AGENT_CLI: process.env.DF_AGENT_CLI,
      DF_AGENT_CLI_COMMAND: process.env.DF_AGENT_CLI_COMMAND,
    },
    {
      generate: (prompt) =>
        runGovernedAgentCall(
          { governor, runHistory, runId },
          {
            category: "developer",
            model: modelId,
            inputTokens: Math.ceil(prompt.length / 4),
            outputTokens: 8_000,
            run: async () => {
              const stream = streamText({ model, prompt });
              let output = "";
              for await (const chunk of stream.textStream) output += chunk;
              return output;
            },
          },
        ),
    },
  );

  // #354 — the vault path runs git INSIDE the sandbox, where the egress sidecar injects the push
  // credential. That forces the git flow into the coding phase, because runCodingPhase disposes the
  // sandbox in a `finally`; the phase therefore needs the provider, not just its tools.
  const vaultPath =
    (process.env.DF_SANDBOX_VAULT_ENABLED ?? "").trim() !== "" &&
    (process.env.DF_SANDBOX_DRIVER ?? "").trim() === "opensandbox";

  // A path INSIDE the container: process.cwd() is a HOST path, so the vault path roots both the loop
  // and the git flow at the same container directory the driver uses.
  const sandboxWorkspace =
    (process.env.DF_SANDBOX_WORKSPACE ?? "").trim() ||
    DEFAULT_SANDBOX_WORKSPACE;

  const gitHost = (
    process.env.DF_SANDBOX_EGRESS_GIT_HOST ?? "github.com"
  ).trim();

  const sandboxRemoteUrl = `https://${gitHost}/${repoOwner}/${repoName}.git`;

  // #718: the ONE fix cycle, built here where everything it needs is resolved. The workspace, the
  // author and the remote are accessors because the phase's replays and the re-entry resolve them at
  // different times; each resolves when a pass actually runs, which is after this point in every case.
  const fixCycle = buildFixCycleAdapter({
    runId,
    branchName,
    remoteUrl: () => sandboxRemoteUrl,
    workspaceDir: () => sandboxWorkspace,
    author: () => codeAuthor,
    createProvider: (sandboxRunId) =>
      createSandboxProvider(
        undefined,
        vaultPath
          ? {
              gitPushCredential: {
                host: gitHost,
                path: `/${repoOwner}/${repoName}.git*`,
                token,
              },
            }
          : undefined,
        sandboxRunId,
      ),
    log: line,
  });

  // STEP 3: Architect Agent Planning Phase
  //
  // #365 R4: on a RESUME the plan is NOT regenerated. A fresh plan is a different plan from the one a human
  // approved, so the approved plan is read back off the ticket instead - and if it cannot be read, the run
  // stops rather than guessing.
  // Hoisted above the run record: a resume changes how a held claim is treated (#373).
  const approvedPlan = isResume
    ? await loadApprovedPlan(
        {
          listComments: (owner, repo, issue) =>
            issueWriter.listComments(owner, repo, issue),
        },
        {
          owner: targetRepo.split("/")[0],
          repo: targetRepo.split("/")[1],
          issue: issueNum,
        },
      )
    : undefined;

  // #703 (Leg C): a run whose only obstacle WAS its pull request's checks is re-entered to ACQUIRE THE
  // VERDICT, not to do the work again. Re-planning would produce a different plan from the one a human
  // approved, and re-coding would redo a change that is already pushed - so this runs the Definition of
  // Done alone, against the pull request the run already recorded, and adopts the SAME run.
  if (isResume) {
    const adopted = await runHistory.getRun(runId);
    const adoptedEvents = await runHistory.listRunEvents(runId);
    const adoptedStream = (adoptedEvents.value?.items ?? []).map(({ event }) => event);

    if (
      adopted.ok &&
      adopted.value &&
      adoptedEvents.ok &&
      isWaitingOnChecks(adoptedStream)
    ) {
      console.log(
        `\n[STEP 3] Resuming a run that was WAITING ON ITS CHECKS: reading them again rather than re-coding...`,
      );

      // #702: the run is `blocked`, and the ledger refuses any work event from that state - so it must be
      // marked resumed before the Definition of Done can record anything.
      const marked = await recordRunResumed(runHistory, { runId });
      if (!marked.ok) {
        console.warn(
          `[WARN] The resumed run could not be marked resumed: ${marked.error ?? "unknown error"}`,
        );
      }

      const prUrl = adopted.value.prUrl;
      const prNumberFromUrl =
        prUrl === undefined ? Number.NaN : Number(prUrl.split("/").pop());
      const recordedPr =
        prUrl === undefined || !Number.isFinite(prNumberFromUrl)
          ? undefined
          : {
              number: prNumberFromUrl,
              url: prUrl,
              head: branchName,
              base: "main",
              title: `feat: #${issueNum} ${issueData.title}`,
              body: "",
            };

      await checkpoint();
      await runDefinitionOfDonePhase(
        {
          runHistory,
          labelWriter,
          prWriter,
          postIssueComment: (owner, repo, issue, body) =>
            issueWriter.postComment(owner, repo, issue, body),
          makeCheckFetcher: (prNumber) =>
            makePullRequestCheckFetcher({ token, repo: targetRepo, prNumber }),
          attemptFixes: fixCycle,
          log: line,
        },
        {
          runId,
          repo: targetRepo,
          issue: issueNum,
          head: branchName,
          // No test results on a verify-only re-entry - the loop did not run this time. The pull request
          // already exists, so title/body are never used to open one.
          title: `feat: #${issueNum} ${issueData.title}`,
          body: "",
          ...(recordedPr === undefined ? {} : { existingPr: recordedPr }),
        },
      );

      // #503 AC5: the run ended through its own terminal lifecycle (or was deliberately left in flight).
      await activeControlStore?.close?.();
      activeControlStore = null;
      activeRun = null;
      return;
    }
  }

  console.log(
    isResume
      ? `\n[STEP 3] Resuming: reading the approved plan back from the ticket...`
      : `\n[STEP 3] Architect Agent discovering repository structure and planning story...`,
  );
  const planReader = createWorkspaceReader(planWorkspace);
  // #521: the planning budget is resolved HERE, at the composition root, mirroring createTesterAgent. An
  // operator override is used as-is; when it is unset the agent derives a budget per attempt from the prompt
  // size, because that is what drives latency (a fixed 60s against a 400k-char prompt budget failed larger
  // stories outright: run df572110).
  const architectTimeoutMs = resolveArchitectTimeoutMs();
  // #492: planning usage reaches the ledger under its own task type, so planning spend can be separated from
  // implementation spend. `createWorkerUsageRecorder` returns null when DF_USAGE_DRIVER is unset — that IS the
  // opt-in — and the recorder is best-effort by construction, so a ledger outage cannot fail a planning attempt.
  const architectUsage = createWorkerUsageRecorder(process.env, {
    runId,
    model: modelId,
    // Attribution the ledger's `pbiId` field exists for: a live run showed the event landing without it.
    pbiId: issueNum,
  });

  /**
   * Measured cost for the ledger, from the provider's own token counts. An unpriced model yields NO cost rather than
   * a zero: the ledger reports an absent measurement as `unmeasured`, while 0 would read as "this call was free".
   */
  const measuredCost = (tokensIn?: number, tokensOut?: number): number | undefined => {
    if (tokensIn === undefined && tokensOut === undefined) return undefined;
    if (resolvePrice(modelId) === null) return undefined;
    return estimateCost(modelId, tokensIn ?? 0, tokensOut ?? 0);
  };

  const architectAgent = new ArchitectAgent({
    // #521: an explicit budget wins over the derivation.
    ...(architectTimeoutMs !== undefined ? { timeoutMs: architectTimeoutMs } : {}),
    // #405: both readers are rooted at the verified plan workspace, so `dir` is honored instead of
    // being replaced by process.cwd(). #381 R1: the Architect plans from file CONTENTS, not just a
    // file list; the agent's own bounded reader still applies sanitizeRelativePath and bounds how
    // many files are read and how much of each. The reader also refuses a path outside the root.
    listFiles: planReader.listFiles,
    readFile: planReader.readFile,
    generateText: async (prompt, options) => {
      // #450: name the attempt in the streamed output, so raw text can be attributed to an attempt.
      const planAttempt = options?.attempt;
      await checkpoint();
      // Governed (#270): an over-budget call is refused at THIS call site, and the
      // refusal code is recorded on the run.
      const planningAttempt = await runGovernedAgentCall(
        { governor, runHistory, runId },
        {
          // #484: architect planning is its own category, so plan spend stops consuming the
          // developer ceiling and becomes separately attributable.
          category: "architect",
          model: modelId,
          inputTokens: Math.ceil(prompt.length / 4),
          outputTokens: 8_000,
          // #492: supplied HERE and nowhere else, so the developer and tester paths keep writing exactly what they
          // wrote before (AC3). Absent fields stay absent on the event rather than being written as zero.
          ...(architectUsage
            ? {
                usage: {
                  taskType: "architect",
                  sink: architectUsage,
                  measurementOf: (attempt: {
                    tokensIn?: number;
                    tokensOut?: number;
                    durationMs?: number;
                  }) => ({
                    tokensIn: attempt.tokensIn,
                    tokensOut: attempt.tokensOut,
                    durationMs: attempt.durationMs,
                    costUsd: measuredCost(attempt.tokensIn, attempt.tokensOut),
                  }),
                },
              }
            : {}),
          run: async () => {
            const streamStartedAt = Date.now();
            const stream = streamText({ model, prompt });
            let output = "";
            if (planAttempt !== undefined) {
              process.stdout.write(`
[PLAN attempt ${planAttempt}]
`);
            }
            for await (const chunk of stream.textStream) {
              output += chunk;
              process.stdout.write(chunk);
            }
            // #492: the provider's OWN usage, which is what makes the ledger entry a measurement rather than a guess.
            const usage = await stream.usage;
            return {
              output,
              tokensIn: usage.inputTokens,
              tokensOut: usage.outputTokens,
              durationMs: Date.now() - streamStartedAt,
            };
          },
        },
      );

      // The agent's contract is the model's TEXT; the measurement is for the ledger only.
      return planningAttempt.output;
    },
    maxPlanRetries: 2,
  });

  // A resume uses the approved plan; only a fresh run asks the architect. The architect is not merely
  // ignored here - it is never called, which is the property the test pins.
  let planResult = approvedPlan
    ? approvedPlan.ok
      ? { ok: true as const, plan: approvedPlan.plan as ExecutionPlan }
      : {
          ok: false as const,
          error: `the approved plan could not be read: ${approvedPlan.error}`,
          // No Architect ran on a resume, so there is no discovery reason to act on (#381 R2).
          reason: undefined,
        }
    : await architectAgent.planStory({
        number: issueNum,
        title: issueData.title,
        body: issueData.body,
      });
  await checkpoint();

  if (!planResult.ok || !planResult.plan) {
    // #365 R4 Task 4: say WHY, on the ticket. A blocked ticket carrying only a label leaves a human guessing
    // whether the Factory is broken or the plan simply predates the feature - and on a resume the story is
    // about the approval, not about the architect.
    const explanation = explainPlanFailure(
      String(planResult.error ?? "no reason given"),
      { resuming: isResume },
    );
    console.error(`[ERROR] ${explanation}`);

    // #381 R2 AC4 + Task 8: a target that cannot be justified, or a plan that never validated, is a QUESTION
    // for a human rather than a failure. The run parks so it stays resumable - the answer may simply be "the
    // shell is right, go ahead" - and a terminal failure would have thrown that away. Every other fault still
    // fails below: parking is for the faults a person can actually answer.
    if (parksForHumanDecision(planResult.reason)) {
      await issueWriter.postComment(
        repoOwner,
        repoName,
        issueNum,
        `🤖 **Eve** (Dark Factory) — ${explanation}`,
      );
      const reporter = createWorkerReporter(process.env, {
        store: createStateStore(env),
        runHistory,
      });
      const parked = await parkForApproval(
        { reporter, labels: labelWriter },
        {
          runId,
          repo: targetRepo,
          issue: issueNum,
          questionLabel: TRIGGER_LABELS.question,
          occurredAt: new Date().toISOString(),
          // Not the approval question: there is no plan to approve. The question matches the reason, so a
          // plan-shape failure is never reported as a target problem (#381 R2 Task 8).
          question: parkQuestionFor(planResult.reason),
        },
      );
      if (!parked.ok) {
        throw new Error(`the run could not be parked for a target decision: ${parked.error}`);
      }
      const parkedFor =
        planResult.reason === "plan-invalid"
          ? "no attempt produced a valid plan"
          : "the target could not be justified";
      console.log(
        `\n[GATE] Parked on #${issueNum}: ${parkedFor} (${parked.mode}). Nothing coded.`,
      );
      return;
    }
    await issueWriter.postComment(
      repoOwner,
      repoName,
      issueNum,
      `🤖 **Eve** (Dark Factory) — ${explanation}`,
    );
    await issueWriter.addLabel(
      repoOwner,
      repoName,
      issueNum,
      TRIGGER_LABELS.question,
    );
    await applyTerminalLifecycle(
      { labelWriter, runHistory },
      { repo: targetRepo, issue: issueNum, runId, terminalStatus: "failed" },
    );
    throw new Error("Dark Factory Runner stopped after the preceding error.");
  }

  let executionPlan = planResult.plan;
  console.log("\n  -> Architect Planning Succeeded!");
  // #501: display never asserts on plan shape. A real run died here because the architect's
  // self-correction loop returned a plan without acceptanceCriteriaMap and the mapping-count line
  // dereferenced it. A run is aborted by validateExecutionPlan, never by its own progress output;
  // refusing a plan that maps no acceptance criteria is #502.
  for (const { label, value } of planSummaryLines(executionPlan)) {
    line(label, value);
  }

  // #378: a resume whose reply is NOT an explicit approval is plan FEEDBACK, not approval. Amend the plan
  // from the frozen one plus the reply, so a reply such as "the target file is wrong, please update the
  // plan" changes what gets built instead of being silently ignored by a run that codes anyway.
  //
  // This block sits BEFORE the plan comment and BEFORE the park, so the amended plan is what gets posted
  // and what a human then approves. The coding phase is unreachable on a revision, because
  // `parksForHumanApproval()` returns true for one and the park path ends the run.
  let revisionRound: number | undefined;

  if (isResume && isRevision) {
    const maxRevisions = resolveMaxPlanRevisions(env);

    const counted = await readPlanRevisionCount(runHistory, runId);
    if (!counted.ok) {
      // Fail closed on an unreadable ledger: assuming zero would let a revision through a cap the
      // operator believes is enforced.
      const explanation = explainPlanFailure(
        `the plan revisions already applied could not be counted: ${counted.error ?? "unknown error"}`,
        { resuming: true },
      );
      console.error(`[ERROR] ${explanation}`);
      await issueWriter.postComment(
        repoOwner,
        repoName,
        issueNum,
        `🤖 **Eve** (Dark Factory) — ${explanation}`,
      );
      await applyTerminalLifecycle(
        { labelWriter, runHistory },
        { repo: targetRepo, issue: issueNum, runId, terminalStatus: "failed" },
      );
      throw new Error("Dark Factory Runner stopped after the preceding error.");
    }

    if (isPlanRevisionCapReached(counted.count, maxRevisions)) {
      const explanation =
        `This plan has already been revised ${counted.count} time(s), which has reached the cap of ` +
        `${maxRevisions} (${MAX_PLAN_REVISIONS_ENV}). Raise that value and clear the ` +
        `'${TRIGGER_LABELS.question}' label for another round, or approve the plan as it stands. ` +
        `Nothing was coded.`;
      console.error(`[ERROR] ${explanation}`);
      await issueWriter.postComment(
        repoOwner,
        repoName,
        issueNum,
        `🤖 **Eve** (Dark Factory) — ${explanation}`,
      );
      await applyTerminalLifecycle(
        { labelWriter, runHistory },
        { repo: targetRepo, issue: issueNum, runId, terminalStatus: "failed" },
      );
      throw new Error("Dark Factory Runner stopped after the preceding error.");
    }

    console.log(
      `\n[STEP 3b] Revising the plan from the feedback (round ${counted.count + 1}/${maxRevisions})...`,
    );
    const amended = await architectAgent.amendPlan({
      story: { number: issueNum, title: issueData.title, body: issueData.body },
      currentPlan: executionPlan,
      feedback: answerResult.answer ?? "",
    });
    if (!amended.ok || !amended.plan) {
      const explanation = explainPlanFailure(String(amended.error ?? "no reason given"), {
        resuming: true,
      });
      console.error(`[ERROR] ${explanation}`);
      await issueWriter.postComment(
        repoOwner,
        repoName,
        issueNum,
        `🤖 **Eve** (Dark Factory) — ${explanation}`,
      );
      await applyTerminalLifecycle(
        { labelWriter, runHistory },
        { repo: targetRepo, issue: issueNum, runId, terminalStatus: "failed" },
      );
      throw new Error("Dark Factory Runner stopped after the preceding error.");
    }

    // #770: the file list, so rule 1b can actually compare the plan to the repository. Without it the guard
    // `if (Array.isArray(context?.files))` is false and the existence rule silently never runs.
    const amendedValidation = validateExecutionPlan(amended.plan, issueData.body, {
      files: await planReader.listFiles("."),
    });
    if (!amendedValidation.valid) {
      console.error(
        `[ERROR] The amended plan failed domain validation:`,
        amendedValidation.errors,
      );
      await applyTerminalLifecycle(
        { labelWriter, runHistory },
        { repo: targetRepo, issue: issueNum, runId, terminalStatus: "failed" },
      );
      throw new Error("Dark Factory Runner stopped after the preceding error.");
    }

    executionPlan = amended.plan;
    console.log(
      `  -> Amended plan: ${executionPlan.targetFiles.map((f) => f.path).join(", ")}`,
    );
    revisionRound = counted.count + 1;

    // Record the round by RESUMING the run, which is what the reply actually is. A dedicated event was
    // tried first and the ledger refused it, correctly: from `blocked` only `run.resumed` or
    // `run.terminal` may follow, which is the rule that stops a parked run accumulating work while it
    // waits. The re-park below then takes it back to `blocked`, so the pair describes the round exactly.
    // A ledger outage is logged LOUDLY but does NOT stop the run: the run still parks, and coding stays
    // unreachable without an explicit approval, so failing open can only under-count the cap.
    const recorded = await recordPlanRevision(runHistory, {
      runId,
      revisionId: `${counted.count + 1}:${answerResult.answer ?? ""}`,
    });
    if (!recorded.ok) {
      console.warn(
        `[WARN] The revision round could not be recorded: ${recorded.error ?? "unknown error"}`,
      );
    }
  }

  // #702: a plain APPROVAL resume must move the run off `blocked` too. The ledger permits only
  // `run.resumed` or `run.terminal` from that state, so without this the summary stayed
  // `blocked`/`worker` for the whole coding phase and every later work event was refused - the
  // Definition of Done's `pr.opened` was the first to hit it, so nothing the run did was recorded.
  // The revision branch above records its own round; this covers the approval. A different event id,
  // deliberately: approving a plan must not spend one of the revision rounds.
  // Logged LOUDLY but does NOT stop the run, matching the revision branch - a ledger outage must not
  // turn an unrecorded resume into an unreported one.
  if (isResume && !isRevision) {
    const marked = await recordRunResumed(runHistory, { runId });
    if (!marked.ok) {
      console.warn(
        `[WARN] The resumed run could not be marked resumed: ${marked.error ?? "unknown error"}`,
      );
    }
  }

  // STEP 4: Pre-flight Domain Validation
  console.log(
    `\n[STEP 4] Validating ExecutionPlan against domain constraints...`,
  );
  // #770: same list, same reason as the amended path above - BOTH call sites matter, and wiring only one is the
  // recurring shape in this file.
  const validation = validateExecutionPlan(executionPlan, issueData.body, {
    files: await planReader.listFiles("."),
  });
  if (!validation.valid) {
    console.error(
      `[ERROR] Plan domain validation rejected:`,
      validation.errors,
    );
    await applyTerminalLifecycle(
      { labelWriter, runHistory },
      { repo: targetRepo, issue: issueNum, runId, terminalStatus: "failed" },
    );
    throw new Error("Dark Factory Runner stopped after the preceding error.");
  }
  console.log("  -> Domain Validation Passed!");

  // STEP 5: Multi-File Developer Agent Execution Loop
  console.log(
    `\n[STEP 5] Dispatched Multi-File Developer Agent with Workspace Tools...`,
  );
  const capturedTestResults: {
    testFile: string;
    testCaseName: string;
    passed: boolean;
  }[] = [];

  // #312: the circuit breaker is a GUARD, not telemetry — it is wired into the coding
  // loop so a PBI that exceeds its worker budget HALTS the run fail-closed (documented
  // defaults: 60 worker-minutes, 3 failed self-correct cycles) instead of continuing to
  // spend. The key is the ISSUE, not the run: a run id contains '/' and '#', which
  // PBI_ID_PATTERN rejects, and a per-run key would reset the budget on every retry.
  const breaker = createCircuitBreaker(process.env);
  const loopBreaker = createCodingLoopBreaker(breaker, issueNum);

  // #281 (R2b/B4): reap orphaned sandboxes from a prior run with the same id before this one starts.
  // The primary release is runCodingPhase's dispose(); this reclaims a sandbox a client-timeout
  // create-leak left behind. Only runs for the opensandbox driver, and never aborts the run on failure.
  if ((process.env.DF_SANDBOX_DRIVER ?? "").trim() === "opensandbox") {
    try {
      const reaped = await reapSandboxesByRun({ runId });
      if (reaped.length)
        console.log(
          `[STEP 5] reaped ${reaped.length} orphaned sandbox(es) from a prior run`,
        );
    } catch (e) {
      console.error(
        `[WARN] sandbox reaping failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }


  // #365 Task 11: put the plan on the ticket BEFORE the coding loop, so the intent is reviewable even if
  // the run fails during coding. Idempotent: a retry updates its own comment instead of adding another.
  // Fail-closed, because a plan nobody can read before coding is the defect this exists to fix, and every
  // other ticket write in this run already has to succeed.
  // #488: price the plan ONCE, before the comment. The band a human approves and the row the ledger
  // keeps have to be the same numbers, and the comment cannot read the ledger back (#487, Option B,
  // persists AFTER this post). Best-effort: an unpriced plan still posts a readable comment.
  // #533: the estimator is given the repository's finished runs, so its confidence and revision factor
  // stop being constants. Best-effort: an unreadable history yields an empty window, which is the cold
  // start it already handles, and never fails the plan.
  const planHistory = await readPlanHistory(runHistory, targetRepo);
  const planEstimate = estimatePlanCostSafely({
    plan: executionPlan,
    model: modelId,
    history: planHistory,
  });
  const planComment = await postPlanComment(issueWriter, {
    owner: repoOwner,
    repo: repoName,
    issue: issueNum,
    markdown: renderPlanFile(executionPlan, {
      issueUrl: `https://github.com/${targetRepo}/issues/${issueNum}`,
    }),
    // #373: the plan ITSELF, not only its rendering. Without it the comment carries no machine-readable
    // block, so the run that resumes against this comment cannot read the plan back and stops.
    plan: executionPlan,
    // #488: the band, rendered under the marker. `undefined` renders no section at all, never a
    // placeholder — the comment's absence of a price is the honest rendering of an absence.
    estimate: planEstimate,
  });
  if (!planComment.ok) {
    throw new Error(`the plan comment could not be posted: ${planComment.error}`);
  }
  console.log(`\n[PLAN] Posted the plan on #${issueNum} (${planComment.action}).`);

  // #505 + #487: PERSIST the plan (with the comment reference) and its cost estimate as ONE write.
  // One seam, not two: the ledger is write-once on (run_id, plan_revision) with no upsert, so a second
  // insert for the same revision would be rejected. `recordPlanWithEstimateSafely` delegates the plan
  // row to `recordPostedPlan` (#505), which owns its discipline: the refusing console/dry-run store is
  // skipped LOUDLY, and any other error PROPAGATES, so a broken ledger still fails the run. The estimate
  // (#487) is the OBSERVATION half: its failure is reported and never fails the run.
  //
  // Guarded: a plain resume reuses the plan recorded when it was first posted, so re-recording would
  // breach write-once and re-price a plan nobody re-planned (AC5).
  if (shouldRecordPlanEstimate({ resuming: isResume, revision: isRevision })) {
    const commentRef =
      planComment.id === undefined
        ? undefined
        : {
            provider: "github" as const,
            id: planComment.id,
            url: `https://github.com/${targetRepo}/issues/${issueNum}#issuecomment-${planComment.id}`,
          };
    const recorded = await recordPlanWithEstimateSafely(runHistory, {
      plan: executionPlan,
      runId,
      model: modelId,
      period: utcMonth(),
      planRevision: revisionRound ?? 1,
      storyId: issueNum,
      source: isRevision ? "amendment" : "architect",
      commentRef,
      // #488: the SAME value the comment rendered, so the band a human approved is the band on the row.
      // If pricing failed before the comment, the composer may still price the plan for the ledger —
      // persistence is best-effort and independent (#487), and the comment simply carries no band.
      ...(planEstimate ? { estimate: () => planEstimate } : {}),
    });
    if (recorded.ok) {
      console.log(
        `[PLAN] Persisted plan revision ${revisionRound ?? 1} with its cost estimate (plan #${recorded.planId}).`,
      );
    } else if (recorded.skipped) {
      console.log(
        `[PLAN] NOT persisted (${recorded.error ?? "run history not configured"}) - dry-run.`,
      );
    }
  }

  // #365 R4: STOP here and wait for a human, unless this dispatch IS the human's approval. The plan is on
  // the ticket, so it can be reviewed; nothing is coded until someone approves it. Recording the question is
  // what marks this run "blocked", which is what the resume path looks for (entry.ts resumes only a blocked
  // run). A resume is explicit - `--resume` - exactly as entry.ts requires ("dispatch this run with an
  // explicit resume"), so a re-delivery can never be mistaken for approval.
  if (parksForHumanApproval({ resuming: isResume, revision: isRevision })) {
    const reporter = createWorkerReporter(process.env, {
      store: createStateStore(env),
      runHistory,
    });
    const approval = await parkForApproval(
      { reporter, labels: labelWriter },
      {
        runId,
        repo: targetRepo,
        issue: issueNum,
        questionLabel: TRIGGER_LABELS.question,
        // #378: a re-park after a revision is a DIFFERENT park, so it needs a distinct question event.
        round: revisionRound,
        occurredAt: new Date().toISOString(),
      },
    );
    if (!approval.ok) {
      throw new Error(`the run could not be parked for approval: ${approval.error}`);
    }
    console.log(
      `\n[GATE] Parked on #${issueNum} awaiting approval (${approval.mode}).` +
        (approval.warning ? ` WARNING: ${approval.warning}` : "") +
        (approval.commentUrl ? `\n       Question: ${approval.commentUrl}` : ""),
    );
    return;
  }

  let loopResult: LoopResult;
  // #361 (R2): what the coding loop actually wrote, captured across the phase callback so BOTH commit
  // paths can stage it - the in-sandbox commit (inside the callback) and the host STEP 6 commit
  // (after it). It has to be declared in THIS scope: a declaration inside the callback is invisible to
  // STEP 6, which is exactly where the compile error was.
  let lastAuthored: AuthorFilesResult | undefined;
  // #361 (Task 10): the rendered plan's path once it has been written, so both commit paths include it
  // and the pull request body can link to it.
  let planArtifactPath: string | undefined;
  try {
    loopResult = await runCodingPhase(
      createSandboxProvider(
        undefined,
        vaultPath
          ? {
              gitPushCredential: {
                host: gitHost,
                // Narrow on purpose: this repo's push endpoint only.
                path: `/${repoOwner}/${repoName}.git*`,
                token,
              },
            }
          : undefined,
        runId,
      ),
      vaultPath ? sandboxWorkspace : process.cwd(),
      async (workspaceTools, sandboxProvider) => {
        // BEFORE the loop writes anything: `git clone` refuses a non-empty target directory.
        if (sandboxProvider.runGit) {
          const prepared = await ensureSandboxRepo({
            runGit: sandboxProvider.runGit,
            remoteUrl: sandboxRemoteUrl,
            workspaceDir: sandboxWorkspace,
            // #744: name the issue branch, so the prepare step can continue it on a re-run instead
            // of restarting from the default tip and hitting a rejected push.
            branchName: `feat/dark-factory-${issueNum}`,
          });
          if (!prepared.ok) {
            throw new Error(
              `sandbox repository preparation failed: ${prepared.error}`,
            );
          }
          // #657: name the base the run's branch will be cut from. Without this a stale checkout was
          // only discoverable from the PR's merge base, after the fact.
          if (prepared.base) {
            console.log(
              `  -> Sandbox checkout synced to ${prepared.base.after.slice(0, 7)} (from ${prepared.base.before.slice(0, 7)})`,
            );
          }
        }
        // #659: which checks the TARGET declares, resolved once from its own package.json. An absent or
        // unreadable manifest resolves to NOTHING, which is UNMEASURED - never reported as lint-clean.
        const targetLintCommands = await (async (): Promise<string[]> => {
          try {
            return resolveLintCommands(
              JSON.parse(await workspaceTools.readFile("package.json")),
            );
          } catch {
            return [];
          }
        })();

        // #701: the target's own e2e suite, resolved from the same manifest. The loop does not RUN it, and
        // saying so is the point: a bare `PASS` otherwise reads as "this work is verified" while the e2e has
        // never executed - which is how a PR opens green-by-the-loop and red in CI.

        const loopOutcome = await runMultiFileCodingLoop({
          plan: executionPlan,
          tools: workspaceTools,
          maxIterations: developerAgent.maxIterations,
          breaker: loopBreaker,
          checkpoint,
          worker: async (ctx) => {
            console.log(
              `  -> Coding Iteration ${ctx.iteration}/${developerAgent.maxIterations}...`,
            );

            // #281 (R2b/B1): the author is configuration-selected. With DF_CODE_AUTHOR unset this is the
            // same governed path as before; a failed author propagates as a failed iteration.
            let authored: AuthorFilesResult;
            try {
              authored = await authorFiles(
                codeAuthor,
                ctx.plan,
                ctx.tools,
                // #373: the last iteration's failure, so the loop can actually self-correct.
                ctx.previousFailure?.output,
              );
            // #361 (R2): the commit after the loop stages `lastAuthored`, not just the plan's targets.
            lastAuthored = authored;
            // #763 R2: the approved plan's targetFiles is a CONTRACT, and this is the moment the runner learns what
            // the run actually wrote. Enforced HERE rather than at commit time because the requirement is about what
            // the run writes - a written-but-uncommitted file would slip past a later check, and the escape in
            // practice was a fix cycle writing a CI workflow.
            //
            // Throwing fails this ITERATION rather than the run: the coder gets the paths back and can correct
            // itself, and a run only commits on a passing iteration, so a rejected write is never staged. The
            // alternative - widening the approved set to accommodate the write - would make the approval meaningless
            // in exactly the case it exists for.
            const outsideApprovedSet = pathsOutsideApprovedSet(authored.written, ctx.plan ?? {});
            if (outsideApprovedSet.length > 0) {
              throw new Error(
                `The run wrote ${outsideApprovedSet.length} path(s) outside the approved plan's target set: ` +
                  `${outsideApprovedSet.join(", ")}. That set is a contract; refusing rather than widening it.`,
              );
            }
            } catch (err: any) {
              return {
                passed: false,
                output: `Authoring error: ${err.message}`,
              };
            }
            for (const filePath of authored.written) {
              console.log(
                `     Wrote ${filePath} (${authored.files[filePath].length} chars)`,
              );
            }
            for (const { path: skippedPath, reason } of authored.skipped) {
              console.log(`     Skipped ${skippedPath}: ${reason}`);
            }

            // Run vitest to verify acceptance criteria
            const testOutcome = await ctx.tools.runTests("npx vitest run");
            if (!testOutcome.ran) {
              // #541: the test command could not even start (e.g. the checkout was not provisioned), so this
              // iteration is unmeasured — our environment's failure, not the developer's — and must not trip the
              // breaker. The run is not recorded as passing, and nothing is silently blamed on the code.
              console.log(
                "     Test result: COULD NOT RUN — the tests did not start (the checkout may be unprovisioned); this iteration is unmeasured",
              );
              // #559: the signal above used to die with the console line. Record it as a roadblock
              // so an environment failure is readable against the run and on the ticket. The capture
              // is OBSERVATIONAL: it is wrapped so a store or reporter failure can never change the
              // #541 semantics below - the iteration stays unmeasured either way.
              if (activeRun) {
                try {
                  const recorder = resolveAgentOutputRecorder("developer");
                  const prepared = recorder.prepare({
                    profile: "developer",
                    type: "roadblock",
                    text:
                      `iteration ${ctx.iteration}: the tests did not start ` +
                      `(the checkout may be unprovisioned): ${testOutcome.output ?? ""}`,
                  });
                  // One identity per run+iteration, so a retry EDITS the rolling comment rather
                  // than stacking another one.
                  await createWorkerReporter(process.env, {
                    store: createStateStore(env),
                    runHistory: activeRun.runHistory,
                  }).report({
                    kind: "roadblock",
                    runId: activeRun.runId,
                    repo: activeRun.repo,
                    issue: activeRun.issue,
                    eventId: `roadblock:${activeRun.runId}:${ctx.iteration}`,
                    occurredAt: new Date().toISOString(),
                    question: prepared.text,
                  });
                } catch (error) {
                  console.log(
                    `     (the unmeasured roadblock could not be recorded: ${
                      error instanceof Error ? error.message : String(error)
                    })`,
                  );
                }
              }
              return { passed: false, output: testOutcome.output, unmeasured: true };
            }

            // #701: the target's OWN e2e suite, run here rather than left for CI to discover. The command
            // set is stated at the call site (#437): the loop does not widen its own blast radius. A suite
            // that cannot START is unmeasured - not a verdict on authored code - so only an actual FAILURE
            // changes the gate.
            // #739: the target's declared e2e is NOT run here. It runs on the pull request,
            // where the DoD reads the target's own checks - so the gate is the unit tier alone.
            const { gatePassed, environmentFault } = decideGate(testOutcome.passed);
            const gateOutput = testOutcome.output;

            console.log(
              `     Test result: ${formatTestVerdict(gatePassed, {
                ran: ["unit"],
                notRun:
                  [],
              }, "deferred")}`,
            );

            // #651: the failure the model must act on used to be discarded here, so a run could fail
            // repeatedly with no visible cause. Print a BOUNDED tail of it (the run's own test output,
            // never user content) so the cause is readable in the log.
            if (!gatePassed && gateOutput) {
              const tail = gateOutput.trim().slice(-1200);
              if (tail) console.log(`     Test failure (tail):\n${tail}`);
            }

            if (gatePassed) {
              // #503 AC4: record a passing result for each mapped AC. The map is typed as required but a
              // deserialized plan may omit it (the architect returned one without it at STEP 3.5), so
              // iterate the fallback, not the field directly.
              recordExecutedTestResults(gateOutput, capturedTestResults);

              // #659: green tests are not "done" if the target's own checks fail. The PR is what a human
              // has to get merged, so the run has to satisfy the checks the repository itself runs. A lint
              // failure is returned as a FAILED ITERATION, so the existing self-correction loop fixes it
              // exactly as it fixes a failing test - the run cannot reach done while they are red.
              const checkOutcomes: { ran: boolean }[] = [];
              for (const lintCommand of targetLintCommands) {
                // The lint set is stated AT THE CALL SITE rather than folded into the agent's shared
                // list (#437): a consumer names its own commands, exactly as the AMM scan does.
                const lint = await ctx.tools.runTests(lintCommand, {
                  allowedCommands: workspaceCommandsFor(targetLintCommands),
                });
                // #674: EVERY declared check is reported, including one that could not start. The
                // silent `continue` that used to stand here printed nothing and threw away the output
                // holding the reason, so the log could not answer "did the loop run the check that
                // failed?". An unmeasured check is still not a verdict - it just is not silence either.
                for (const outcomeLine of checkOutcomeLines(lintCommand, lint)) {
                  console.log(outcomeLine);
                }
                checkOutcomes.push({ ran: lint.ran });
                if (lint.ran && !lint.passed) {
                  // Same reasoning as the test path above: a bare "FAIL" is undiagnosable once the
                  // sandbox is disposed, so the banner above carries a BOUNDED tail of the cause.
                  return {
                    passed: false,
                    output:
                      `The repository's own check failed: ${lintCommand} (the target's lint is part of ` +
                      `done)\n\n${lint.output}`,
                  };
                }
              }
              if (targetLintCommands.length > 0) {
                console.log(checkSetSummary(checkOutcomes));
              }
            }

            // #651: report the identity of what this iteration authored, so the loop can detect a no-op
            // self-correction (a failing iteration that reproduces the previous failing artefact).
            return {
              passed: gatePassed,
              ...(environmentFault ? { environmentFault: true } : {}),
              // #731: an environment fault is not for the model to fix, so it
              // is given no feedback - the next iteration would author the same artefact.
              output: environmentFault ? "" : gateOutput,
              artefactHash: authored.artefactHash,
            };
          },
        });
        // #361 (Task 10): render the plan into the workspace BEFORE either commit path runs, so the
        // run's intent reaches the branch even though it was produced before any code was written.
        if (loopOutcome.status === "success") {
          planArtifactPath = planFilePath(issueNum);
          await workspaceTools.writeFile(
            planArtifactPath,
            renderPlanFile(executionPlan, {
              issueUrl: `https://github.com/${targetRepo}/issues/${issueNum}`,
            }),
          );
          console.log(`\n[PLAN] Wrote ${planArtifactPath} for review.`);
        }
        // AFTER the loop, and BEFORE runCodingPhase disposes the sandbox.
        if (sandboxProvider.runGit && loopOutcome.status === "success") {
          // #704: capture the run's diff BEFORE the commit below. The capture diffs against HEAD, so after the commit
          // there is nothing left to see - a capture placed after it would record no diff while looking wired, which
          // is the "a check that cannot fire" shape this factory keeps finding.
          const diffOutcome = await recordRunDiffWithOutcome(runHistory, runId, sandboxWorkspace, {
            runGit: gitRunnerForCapture(sandboxProvider.runGit),
          });
          if (diffOutcome === "failed") {
            console.error("[STEP 5] Capturing the run diff failed; the run continues without one.");
          } else {
            console.log(`[STEP 5] Run diff ${diffOutcome}.`);
          }
          const pushed = await commitAndPushFromSandbox({
            runGit: sandboxProvider.runGit,
            remoteUrl: sandboxRemoteUrl,
            workspaceDir: sandboxWorkspace,
            branchName,
            commitMessage: `feat: #${issueNum} ${executionPlan.title}`,
            filesToAdd: filesToCommitFromRun(
              lastAuthored,
              executionPlan,
              planArtifactPath ? [planArtifactPath] : [],
            ),
          });
          if (!pushed.ok) {
            throw new Error(`sandbox push failed: ${pushed.error}`);
          }
        }
        return loopOutcome;
      },
    );
  } catch (error) {
    // #376: the failure path is extracted so it is testable, and it ends the run for ANY
    // failure after acceptance — not only a circuit trip.
    await finalizeCodingPhaseFailure(
      { labelWriter, runHistory, breaker },
      { repo: targetRepo, issue: issueNum, runId },
      error,
    );
    throw error;
  }

  if (loopResult.status !== "success") {
    console.error("[ERROR] Developer Agent failed to achieve passing tests.");
    await applyTerminalLifecycle(
      { labelWriter, runHistory },
      { repo: targetRepo, issue: issueNum, runId, terminalStatus: "failed" },
    );
    throw new Error("Dark Factory Runner stopped after the preceding error.");
  }

  // STEP 6: Commit and Push Task Branch
  if (vaultPath) {
    // #354: on the vault path the commit AND the push already happened inside the sandbox, before it
    // was disposed, using the vault-injected credential. The host working tree is untouched (the loop
    // wrote into the sandbox), so there is nothing to stage, commit or push here.
    console.log(
      `\n[STEP 6] Branch '${branchName}' was committed and pushed from inside the sandbox.`,
    );
  } else {
    console.log(
      `\n[STEP 6] Committing changes to '${branchName}' and pushing to GitHub...`,
    );
    const filesToCommit = filesToCommitFromRun(
      lastAuthored,
      executionPlan,
      planArtifactPath ? [planArtifactPath] : [],
    ).join(" ");
    await checkpoint();
    // #373: the task branch must EXIST before anything is committed to it. Without this the commit landed
    // on whatever was checked out - `main`, in a local run - so no ref was created and the push died with
    // git reporting that the ref it was handed does not exist. That is what stopped a local run reaching a PR. The sandbox path
    // is unaffected: it commits inside the sandbox.
    try {
      execSync(`git checkout -b ${branchName}`, { stdio: "inherit" });
    } catch {
      // The branch already exists (a retry, or an earlier attempt). Use it rather than resetting it: a
      // reset here would discard work that may already be under review.
      execSync(`git checkout ${branchName}`, { stdio: "inherit" });
    }
    await checkpoint();

    execSync(`git add ${filesToCommit}`, { stdio: "inherit" });
    await checkpoint();
    execSync(`git commit -m "feat: #${issueNum} ${executionPlan.title}"`, {
      stdio: "inherit",
    });
    await checkpoint();

    // R3 (#282/T2): the push token lives write-only in the credential vault; the authed URL is never built.
    const ownerRepo = targetRepo.split("/");
    const pushVault = createInMemoryCredentialVault({
      allowList: ["git-push"],
    });
    await pushVault.put("git-push-token", token);
    try {
      // #373: name the real reason rather than leaking git's own ref error, which describes the symptom
      // (a missing ref) and not the cause (nothing created the branch).
      const headBranch = execSync("git rev-parse --abbrev-ref HEAD")
        .toString()
        .trim();
      if (headBranch !== branchName) {
        throw new Error(
          `refusing to push: HEAD is '${headBranch}' rather than the task branch '${branchName}'`,
        );
      }

      await gitPushWithVault({
        owner: ownerRepo[0],
        repo: ownerRepo[1],
        branchName,
        vault: pushVault,
      });
    } catch (pushError) {
      console.error(
        `[ERROR] Failed to push branch '${branchName}': ${pushError instanceof Error ? pushError.message : String(pushError)}`,
      );
      await applyTerminalLifecycle(
        { labelWriter, runHistory },
        { repo: targetRepo, issue: issueNum, runId, terminalStatus: "failed" },
      );
      throw new Error("Dark Factory Runner stopped after the preceding error.");
    }
    console.log(`  -> Pushed '${branchName}' successfully!`);
  }

  // STEP 7: Definition of DONE with AC Traceability Matrix
  console.log(`\n[STEP 7] Executing Hardened Definition of DONE (#179)...`);
  await checkpoint();
  await runDefinitionOfDonePhase(
    {
      runHistory,
      attemptFixes: fixCycle,
      labelWriter,
      prWriter,
      postIssueComment: (owner, repo, issue, body) =>
        issueWriter.postComment(owner, repo, issue, body),
      makeCheckFetcher: (prNumber) =>
        makePullRequestCheckFetcher({ token, repo: targetRepo, prNumber }),
      log: line,
    },
    {
      runId,
      repo: targetRepo,
      issue: issueNum,
      head: branchName,
      plan: executionPlan,
      // #716: the counters the loop ALREADY knows. Without them the Definition of Done has nothing to
      // spread into its writes, so the summary falls back to a fabricated `0` - which is how a run whose
      // own log reads "Coding Iteration 2/10" is recorded as having iterated zero times, and a reader
      // cannot tell UNMEASURED from GENUINELY ZERO.
      // The REPRESENTATION of an unmeasured counter (optional/NULL, rendered as `-`) is #768. This is
      // the SUPPLY, which is the half that makes the recorded number true from here on.
      runMetrics: {
        iterationCount: loopResult.iterations,
        fixCycleCount: loopResult.fixCycles,
      },
      title: `feat: #${issueNum} ${executionPlan.title}`,
      body: pullRequestBody({
        issueNum,
        planPath: planArtifactPath,
        repo: targetRepo,
        branch: branchName,
      }),
      ...(capturedTestResults === undefined
        ? {}
        : { testResults: capturedTestResults }),
    },
  );
  console.log(
    "\n================================================================================",
  );
  console.log("DARK FACTORY RUNNER: EXECUTION COMPLETED SUCCESSFULLY");
  console.log(
    "================================================================================\n",
  );
  await activeControlStore?.close?.();
  activeControlStore = null;
  // #503 AC5: the run ended through its own terminal lifecycle; there is nothing left to release.
  activeRun = null;
}

/**
 * #361 — thrown when an authored file would destroy the content already in it.
 *
 * A distinct class rather than a bare Error, so the caller and the tests can tell a preservation
 * refusal from any other authoring failure. The runner's worker turns it into a failed iteration whose
 * message is the next iteration's context.
 */
export class PreservationRefusedError extends Error {
  readonly code = "ERR_PRESERVATION_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "PreservationRefusedError";
  }
}

export interface AuthorFilesResult {
  files: Record<string, string>;
  raw: string;
  /** The paths actually written, in the order they were written. */
  written: string[];
  /** Authored entries that were NOT written, with the reason. */
  skipped: { path: string; reason: string }[];
  /**
   * An opaque identity of the authored work (#651), compared across iterations to detect a no-op
   * self-correction. A digest of `files`, so byte-identical work has an identical identity.
   */
  artefactHash: string;
}

/**
 * The plan's declared action per target path.
 *
 * An entry whose action is missing or unrecognised is treated as `modify`, so an unreadable or lazy
 * plan cannot switch the preservation rule OFF. An empty map means "no prediction to trust".
 */
function readPlanTargetActions(plan: unknown): Map<string, PlanFileAction> {
  const actions = new Map<string, PlanFileAction>();
  const targets = (plan as { targetFiles?: unknown } | null)?.targetFiles;
  if (!Array.isArray(targets)) return actions;
  for (const entry of targets) {
    if (typeof entry !== "object" || entry === null) continue;
    const { path, action } = entry as { path?: unknown; action?: unknown };
    if (typeof path !== "string" || path.trim() === "") continue;
    actions.set(
      path,
      action === "create" || action === "replace" ? action : "modify",
    );
  }
  return actions;
}

/** A file's content, or "" when it does not exist or cannot be read. */
async function readExistingFile(
  tools: { readFile(relPath: string): Promise<string> },
  relPath: string,
): Promise<string> {
  try {
    return await tools.readFile(relPath);
  } catch {
    return "";
  }
}

/**
 * #281 (R2b/B1) — write the authored files into the workspace.
 *
 * The author seam deliberately does NOT write files (it returns the map, keeping the seam pure), so
 * the caller writes them through the SAME workspace tools as before. A failed author propagates: the
 * coding loop records a failed iteration rather than silently writing nothing.
 *
 * #361 — the author is shown the current content of the files it is modifying, and every write is
 * checked against what is already there before a single byte lands. A refused write throws
 * `PreservationRefusedError`, which the caller's worker turns into a failed iteration whose message
 * IS handed to the next iteration as `feedback` (#373 - that sentence described intent, not behavior, until the loop's context carried it).
 */
export async function authorFiles(
  author: CodeAuthorProvider,
  plan: unknown,
  tools: {
    readFile(relPath: string): Promise<string>;
    writeFile(relPath: string, content: string): Promise<void>;
  },
  /** The previous iteration's failure, if any (#373). */
  feedback?: string,
): Promise<AuthorFilesResult> {
  const actions = readPlanTargetActions(plan);

  // #361: show the author what is already inside the files it is changing. Without this it has to
  // regenerate a `modify` target blind from the plan summary — which is how a 75-line component
  // became a 15-line stub while every test still passed.
  const existing: Record<string, string> = {};
  for (const [path, action] of actions) {
    if (action === "create") continue; // a create target is expected not to exist yet
    const content = await readExistingFile(tools, path);
    if (content !== "") existing[path] = content;
  }

  const result = await author.write({
    plan,
    ...(Object.keys(existing).length > 0 ? { existing } : {}),
    ...(feedback && feedback.trim() !== "" ? { feedback } : {}),
  });

  // Read the pre-write content of EVERY authored path before writing any of them: the guard needs
  // what is on disk NOW, and a path the plan did not predict is still an overwrite.
  const before = new Map<string, string>();
  for (const filePath of Object.keys(result.files)) {
    before.set(filePath, await readExistingFile(tools, filePath));
  }

  const refusals: string[] = [];
  for (const [filePath, content] of Object.entries(result.files)) {
    const verdict = assessPreservation({
      path: filePath,
      action: actions.get(filePath) ?? "modify",
      before: before.get(filePath) ?? "",
      after: content,
    });
    if (!verdict.ok) refusals.push(verdict.reason);
  }

  // Fail BEFORE writing anything. A refused iteration must not half-apply itself, or the informed
  // retry would run against a workspace that is already partly destroyed.
  if (refusals.length > 0) {
    throw new PreservationRefusedError(
      `refusing to write ${refusals.length} file(s) that would lose existing code:\n` +
        refusals.map((reason) => `  - ${reason}`).join("\n"),
    );
  }

  const written: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const [filePath, content] of Object.entries(result.files)) {
    // #361: a plan saying `create` for a path that already exists is a contradiction, and the file
    // that is already there wins. Recorded rather than thrown, so the mismatch is visible without
    // failing an otherwise valid iteration.
    if (actions.get(filePath) === "create" && (before.get(filePath) ?? "") !== "") {
      skipped.push({
        path: filePath,
        reason: `'${filePath}' already exists, so the plan's 'create' action was ignored.`,
      });
      continue;
    }
    await tools.writeFile(filePath, content);
    written.push(filePath);
  }
  return {
    files: result.files,
    raw: result.raw,
    written,
    skipped,
    artefactHash: artefactIdentity(result.files),
  };
}

/**
 * #361 (R2) — the files a successful run must commit.
 *
 * The plan's `targetFiles` are what the run INTENDED to touch. What the author actually WROTE can
 * differ: it may add a file the plan never listed (e.g. an authored test), or skip a `create` whose
 * target already existed. Committing the plan's list alone is how an authored test file was lost in
 * #361 — it was written into the sandbox but never staged. The union of the two is what the run
 * produced, and is the honest artifact to stage.
 */
export function filesToCommitFromRun(
  authored: { written: string[] } | undefined,
  plan: { targetFiles: { path: string }[] },
  extraPaths: string[] = [],
): string[] {
  const set = new Set<string>();
  if (authored) for (const path of authored.written) set.add(path);
  for (const target of plan.targetFiles) set.add(target.path);
  // #361 (Task 10): artifacts the run produced itself, e.g. the rendered plan, which is not a target.
  for (const extra of extraPaths) set.add(extra);
  return Array.from(set);
}

/** #361 (Task 10) - where a run commits its rendered plan. */
/**
 * The comment posted to the ticket after the Definition of Done (#659).
 *
 * Gated on the VERDICT, never on a pull request merely existing. A blocked DoD still leaves its PR
 * behind, and announcing "Completed ✅ / df:done" for it put the lie exactly where a human looks - the
 * label path already refuses (`isDoneGateSatisfied`), so the comment was the last thing claiming success.
 * A not-done comment names the status, says so plainly, and carries the findings that stopped the run.
 */
export function dodOutcomeComment(
  issueNum: number,
  dodResult: DefinitionOfDoneResult,
): string {
  if (dodResult.ok && dodResult.pr) {
    return (
      `🤖 **Eve** (Dark Factory) — Story #${issueNum} Completed with Verified Traceability ✅\n\n` +
      `- **PR**: ${dodResult.pr.url}\n` +
      `- **Traceability Matrix**:\n\n${dodResult.traceabilityTable ?? "Verified"}\n` +
      `- **Lifecycle**: \`df:done\``
 +
      // #759: the lifecycle line said the work was finished and stopped there, leaving a reader to
      // guess whether anything was expected of them. The sign-off request says what is being asked and
      // names the two words that answer it.
      "\n\n" +
      renderSignOffComment({
        prNumber: dodResult.pr.number,
        prUrl: dodResult.pr.url,
      })
    );
  }

  const findings = dodResult.remainingFindings
    .map((finding) => `- \`${finding.id}\` (${finding.severity}): ${finding.message}`)
    .join("\n");

  return (
    `🤖 **Eve** (Dark Factory) — Story #${issueNum} is NOT done ❌\n\n` +
    `The run stopped with status \`${dodResult.status}\` and did **not** report done.\n` +
    (dodResult.reason ? `\n- **Reason**: ${dodResult.reason}\n` : "") +
    (dodResult.pr
      ? `- **PR** (left open - do not merge until its checks are green): ${dodResult.pr.url}\n`
      : "") +
    // #673: carry the same traceability the success comment shows. This is the comment a reader
    // opens to understand why the run did not certify, so it must not be the one that says what
    // failed while never saying what the ticket asked for.
    (dodResult.traceabilityTable
      ? `\n**Acceptance criteria**\n\n${dodResult.traceabilityTable}\n`
      : "") +
    // #691: when an unfinished check is the whole of the obstacle the reader needs words, not just
    // the finding id. The run is WAITING rather than wrong - say so, and say how to continue.
    (dodResult.blockedReason === CHECKS_NOT_FINISHED
      ? `\n**Checks not finished**\n\n` +
        `${(dodResult.pendingChecks ?? []).map((name) => `- \`${name}\``).join("\n")}\n\n` +
        `These checks had not finished when the wait reached its bound, so this run cannot certify against\n` +
        `them yet. They may still pass: once they settle, remove and re-apply the \`dark-factory\` label to\n` +
        `re-check.\n`
      : "") +
    (findings ? `\n**Outstanding findings**\n\n${findings}\n` : "") +
    `\n- **Lifecycle**: \`${dodResult.status}\``
  );
}

export function planFilePath(issueNum: number): string {
  return `.hermes/plans/df-${issueNum}.md`;
}

export interface PullRequestBodyOptions {
  issueNum: number;
  planPath?: string;
  repo?: string;
  branch?: string;
}

/**
 * #361 (Task 10) - the pull request body.
 *
 * The plan is linked so a reviewer can read the run's intent without leaving GitHub. The link MUST be
 * absolute: a relative path in a PR body resolves against the pull request page, not the repository, so
 * it would 404.
 */
/**
 * #703 (Leg C): the Definition of Done phase as its own seam.
 *
 * Extracted so a RE-ENTRY can run it without the planning and coding phases. A run that is waiting on its
 * pull request's checks needs only the verdict: re-planning would produce a different plan from the one a
 * human approved, and re-coding would redo a change that is already pushed. The body is a MOVE - the
 * statements are the ones that ran inline at STEP 7 - with injectable seams so the phase can be tested
 * without reaching GitHub.
 */
export interface DodPhaseDeps {
  runHistory: Parameters<typeof applyTerminalLifecycle>[0]["runHistory"];
  labelWriter: Parameters<typeof applyTerminalLifecycle>[0]["labelWriter"];
  /** Opens the pull request. */
  prWriter: PrOpener;
  /** Posts the DoD's outcome comment on the TICKET. */
  postIssueComment: (
    owner: string,
    repo: string,
    issue: number,
    body: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Builds the fetcher for the pull request's checks. REQUIRED rather than defaulted, because only the
   * composition root holds the token - and injectable because that is what lets a test script the checks.
   */
  makeCheckFetcher: (prNumber: number) => ReturnType<typeof makePullRequestCheckFetcher>;
  /** Injectable so a test is not at the mercy of the clock or of a real pause. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (label: string, value: unknown) => void;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * #718: the fix cycle, so the DoD can dispose of the findings its own checks raise.
   *
   * Supplied only where a fix can actually be run. The verify-only re-entry deliberately does NOT
   * carry one: it exists to settle a verdict by re-reading checks, and the workspace, remote and
   * author it would need are resolved later in the run than it executes.
   */
  attemptFixes?: AttemptFixes;
}

export interface DodPhaseArgs {
  runId: string;
  repo: string;
  issue: number;
  head: string;
  base?: string;
  /** The plan the DoD records beside its verdict. Absent on a verify-only re-entry, which has no plan. */
  plan?: ExecutionPlan;
  title: string;
  body: string;
  testResults?: DefinitionOfDoneTask["testResults"];
  /**
   * #716: the counters this run OBSERVED, forwarded verbatim. Absent means unmeasured - and the runner now
   * supplies them, so the number a summary records is the loop's own count rather than a fallback.
   * NOTE: the write paths still coerce an absent value to `0`; making "unmeasured" representable end-to-end
   * is #768, deliberately NOT done here.
   */
  runMetrics?: DefinitionOfDoneTask["runMetrics"];
  /**
   * #703 (Leg C): the pull request this run ALREADY recorded. When present the phase does not open
   * another one - it re-reads the checks for this pull request, which is what makes a verify-only
   * re-entry possible. The same trick the capturing writer used in the other direction: the DoD's own
   * interface stays unchanged.
   */
  existingPr?: DefinitionOfDoneResult["pr"];
}

export interface DodPhaseOutcome {
  result: DefinitionOfDoneResult;
  /** #703: the labels were applied but the run was deliberately left in flight. */
  deferred: boolean;
  prNumber?: number;
}

export async function runDefinitionOfDonePhase(
  deps: DodPhaseDeps,
  args: DodPhaseArgs,
): Promise<DodPhaseOutcome> {
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.timeoutMs ?? PR_CHECKS_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? PR_CHECKS_POLL_INTERVAL_MS;

  // #659: ONE budget for the DoD's check wait. `runChecks` runs once per review round, and passing the
  // full timeout each time made a blocked run against a slow CI wait ten minutes per round for checks
  // that had already concluded (measured: ~25 minutes of silence). Consume a single deadline instead.
  const checkWaitDeadline = now() + timeoutMs;
  // #676: name the cap. The wait returns as soon as the checks settle, so this is a ceiling on a
  // stuck check rather than an expected duration - but a run that is waiting should say so, since
  // the alternative is a silent pause whose length a reader has to guess.
  log("PR checks wait up to", `${Math.round(timeoutMs / 60_000)} min`);

  let prNumber = args.existingPr?.number;
  const existingPr = args.existingPr;

  // #659: the Definition of Done opens the PR itself, and calls runChecks afterwards, so the gate needs
  // the pull request it just opened. Capturing it here keeps the DoD's own interface unchanged.
  const opener: PrOpener =
    existingPr === undefined
      ? {
          createPullRequest: async (owner, repoName, options) => {
            const result = await deps.prWriter.createPullRequest(
              owner,
              repoName,
              options,
            );
            if (result.ok && result.pr) prNumber = result.pr.number;
            return result;
          },
        }
      : {
          // #703 (Leg C): a verify-only re-entry must not open a SECOND pull request for a change that is
          // already pushed and already has one.
          createPullRequest: async () => ({ ok: true, pr: existingPr }),
        };

  const dodTask: DefinitionOfDoneTask = {
    runId: args.runId,
    repo: args.repo,
    issue: args.issue,
    head: args.head,
    base: args.base ?? "main",
    title: args.title,
    body: args.body,
    ...(args.plan === undefined ? {} : { plan: args.plan }),
    ...(args.testResults === undefined ? {} : { testResults: args.testResults }),
    // #716: the same terms as every other optional arg - supplied when the run observed them, absent
    // otherwise, so the DoD spreads a real measurement into its writes.
    ...(args.runMetrics === undefined ? {} : { runMetrics: args.runMetrics }),
  };

  const dodDeps: DefinitionOfDoneDeps = {
    // #702: the store was never passed, so EVERY DoD event was discarded silently - the PR it opened,
    // its review rounds, the acceptance-criteria matrix and the test results never reached the page.
    runHistory: deps.runHistory,
    ...(deps.attemptFixes ? { attemptFixes: deps.attemptFixes } : {}),
    prWriter: opener,
    commentWriter: {
      postComment: async (owner, repo, prNum, body) => {
        const res = await deps.postIssueComment(owner, repo, prNum, body);
        return { ok: res.ok, error: res.error };
      },
    },
    // #659: the checks the PULL REQUEST is actually running. What this replaces ran
    // `npx tsc --noEmit` in THIS process's working directory, which on the vault path is a tree without
    // the run's changes - a check that could never fail on the thing it claimed to check.
    runChecks: async () =>
      checkRunFindings(
        await settlePullRequestChecks({
          fetchChecks:
            prNumber === undefined ? async () => null : await deps.makeCheckFetcher(prNumber),
          sleep,
          timeoutMs: Math.max(0, checkWaitDeadline - now()),
          pollIntervalMs,
        }),
      ),
  };

  const dodResult = await runDefinitionOfDone(dodDeps, dodTask);
  log("DoD Status", dodResult.status);
  log("Is DONE (ok)", dodResult.ok);
  log("AC Matrix Count", dodResult.acMatrix?.length ?? 0);

  if (dodResult.pr) {
    log("Live PR URL", dodResult.pr.url);
  }

  let deferred = false;
  if (dodResult.pr) {
    const finalised = await applyTerminalLifecycle(
      { labelWriter: deps.labelWriter, runHistory: deps.runHistory },
      {
        repo: args.repo,
        issue: args.issue,
        runId: args.runId,
        // #659: the lifecycle follows the VERDICT. It used to be "succeeded" whenever a PR existed, so the
        // record and the ticket comment agreed with each other and disagreed with the DoD.
        // #672: the EVENT status stays terminal-only (run-history rejects "blocked" - a blocked run is
        // resumable, not finished). The nuance belongs on the TICKET, derived from the DoD verdict by the
        // finalizer, which reads dodResult.status directly.
        // #703: and a BLOCKED verdict now means no terminal event at all (see the finalizer): the label
        // still follows the verdict, while the run itself stays in flight so that it can be resumed.
        terminalStatus: dodResult.ok ? "succeeded" : "failed",
        dodResult,
      },
    );
    deferred = finalised.deferred === true;
    // #703: say so out loud, and name the ACTUAL reason. The first draft hardcoded "waiting for the
    // pull request's checks", which printed on a run blocked by a FAILED check - the log misreporting
    // what the record was reporting correctly. Found by reading WebFeedPOC#244's run back.
    if (deferred) {
      const pending = dodResult.pendingChecks ?? [];
      log(
        "Run left in flight (not finalised)",
        `DoD verdict ${dodResult.status} (${dodResult.blockedReason ?? "no reason"}): ${
          pending.length > 0 ? `waiting for ${pending.join(", ")}` : "waiting"
        }`,
      );
    }
  }

  // #659: posted for BOTH outcomes. A run that refused to finish is exactly the run whose ticket must say
  // so - silence there is how a blocked run looked like a success.
  await deps.postIssueComment(
    args.repo.split("/")[0],
    args.repo.split("/")[1],
    args.issue,
    dodOutcomeComment(args.issue, dodResult),
  );

  return {
    result: dodResult,
    deferred,
    ...(prNumber === undefined ? {} : { prNumber }),
  };
}

export function pullRequestBody(options: PullRequestBodyOptions): string {
  const lines = [
    "Autonomous pull request opened by Eve's Developer Agent.",
    "",
    `Closes #${options.issueNum}`,
  ];
  if (options.planPath && options.repo && options.branch) {
    const url = `https://github.com/${options.repo}/blob/${options.branch}/${options.planPath}`;
    lines.push("", `Plan: [\`${options.planPath}\`](${url})`);
  }
  return lines.join("\n");
}

/**
 * #281 (R2b/B2) — the runner owns the sandbox lifecycle.
 *
 * One sandbox per run; it is force-disposed on success AND on throw (closing the SDK client does not
 * terminate a sandbox, so a missing dispose is a leak and spend). The recording-double test proves the
 * order: create -> phase -> dispose, exactly one create, dispose always fires.
 */
/**
 * #718 - the fix cycle's adapter: one sandbox per PASS, for the run that already owns it.
 *
 * The Definition of Done raises findings and has to dispose of them; this is the machinery behind
 * that, kept out of the DoD's own interface. Three things about the shape are load-bearing, and each
 * is asserted in fix-cycle-adapter.test.ts rather than described here:
 *
 * - **The pull request's branch is fetched and checked out BEFORE a fix is authored.** The push that
 *   follows uses `git checkout -B <branch>`, which RESETS the branch to the current HEAD - so a pass
 *   that prepared a default-tip checkout and then pushed would rewrite the pull request's branch to
 *   `main` and destroy the work it was fixing.
 * - **The sandbox is built for THIS run id**, because `reapSandboxesByRun` keys on the run id: a pass
 *   under any other id would be invisible to the reaper and leak with no safety net.
 * - **The workspace is closed on every path**, including the early returns and the throws.
 *
 * The workspace and the author are resolved when a pass RUNS, not when the adapter is built: both
 * belong to the coding phase, which has not run yet at the point the DoD's deps are assembled - and
 * the verify-only re-entry never runs it at all. Passing them as accessors keeps the adapter
 * constructible in one place for both compositions without duplicating it, and without a reference to
 * a `const` above its own declaration.
 */
export interface FixCycleAdapterDeps {
  /** The run the fix belongs to - also the id the sandbox carries, so the reaper can find it. */
  runId: string;
  /** The pull request's head branch: what is checked out, fixed, and pushed. */
  branchName: string;
  /**
   * The remote the branch is fetched from and pushed to. An accessor for the same reason as the
   * workspace: it is derived from the resolved host and repo, which happen later than the DoD deps
   * are assembled.
   */
  remoteUrl: () => string;
  /** Resolved at call time; the coding phase's workspace exists only after the phase has run. */
  workspaceDir: () => string;
  /** Resolved at call time, for the same reason. */
  author: () => CodeAuthorProvider;
  /** Builds the sandbox for a pass. Injected so a recording double can prove the order. */
  createProvider: (runId: string) => SandboxProvider;
  log?: (label: string, value: unknown) => void;
}

/** The handle a fix pass works in: the sandbox, its tools, and what the pass has authored so far. */
interface FixWorkspaceHandle {
  branch: string;
  provider: SandboxProvider;
  runGit: SandboxGitRunner;
  workspaceDir: string;
  tools: WorkspaceTools;
  /** Set by the authoring port, read by the push port. */
  changedFiles: string[];
}

/**
 * The findings as a plan, so a fix reuses the authoring path the coding phase already uses.
 *
 * `authorFiles` reads its target actions from a plan, so a fix has to arrive as one. That is the
 * smaller change than a second authoring seam, and it means the fix inherits that path's guards -
 * including `assessPreservation`, which refuses to write a file that would lose existing code.
 */
function planFromFindings(findings: readonly ReviewFinding[]): unknown {
  const files = [
    ...new Set(
      findings
        .map((finding) => finding.file)
        .filter((path): path is string => typeof path === "string" && path.trim() !== ""),
    ),
  ];
  return {
    title: `Address ${findings.length} review finding(s)`,
    summary: [
      "Fix the findings below. Change only what each finding requires.",
      ...findings.map((finding) => `- [${finding.id}] ${finding.message}`),
    ].join("\n"),
    targetFiles: files.map((path) => ({ path, action: "modify" })),
  };
}

export function buildFixCycleAdapter(deps: FixCycleAdapterDeps): AttemptFixes {
  const log = deps.log ?? (() => {});

  return createFixCycle<FixWorkspaceHandle>({
    openWorkspace: async () => {
      const workspaceDir = deps.workspaceDir();
      const provider = deps.createProvider(deps.runId);
      const tools = provider.create(workspaceDir);
      if (!provider.runGit) {
        // Without git there is no checkout to fix and no push to make, so this is not a workspace
        // this pass can use. Reported rather than thrown: the DoD reports a throw as "the fix
        // attempt failed unexpectedly", which would blame the run.
        return {
          ok: false as const,
          error: "the sandbox driver cannot run git, so a fix cannot be prepared or pushed",
        };
      }
      const runGit = provider.runGit;
      const prepared = await ensureSandboxRepo({
        runGit,
        remoteUrl: deps.remoteUrl(),
        workspaceDir,
        // #744: the fix cycle is itself a re-run path, so it names the issue branch too. Without
        // this it prepares a default-tip checkout, and the push below is rejected as a
        // non-fast-forward - the symptom this issue exists to remove.
        branchName: deps.branchName,
      });
      if (!prepared.ok) {
        return { ok: false as const, error: prepared.error ?? "the checkout could not be prepared" };
      }
      // The pull request's branch, BEFORE a fix is authored: the push below uses `checkout -B`, which
      // resets the branch to the current HEAD. Preparing a default-tip checkout and then pushing
      // would rewrite the pull request's branch to main and discard the work being fixed.
      const fetched = await runGit(["-C", workspaceDir, "fetch", "origin", deps.branchName]);
      if (fetched.exitCode !== 0) {
        return {
          ok: false as const,
          error: `git fetch failed (exit ${fetched.exitCode}): ${fetched.output}`,
        };
      }
      const checkedOut = await runGit(["-C", workspaceDir, "checkout", deps.branchName]);
      if (checkedOut.exitCode !== 0) {
        return {
          ok: false as const,
          error: `git checkout failed (exit ${checkedOut.exitCode}): ${checkedOut.output}`,
        };
      }
      log("Fix cycle", `prepared '${deps.branchName}' in a sandbox for run ${deps.runId}`);
      return {
        ok: true as const,
        workspace: {
          branch: deps.branchName,
          provider,
          runGit,
          workspaceDir,
          tools,
          changedFiles: [],
        },
      };
    },

    author: async (workspace, findings) => {
      const authored: AuthorFilesResult = await authorFiles(
        deps.author(),
        planFromFindings(findings),
        workspace.tools,
      );
      workspace.changedFiles = [...authored.written];
      log(
        "Fix cycle",
        `authored ${workspace.changedFiles.length} file(s) for ${findings.length} finding(s)`,
      );
      return { changedFiles: workspace.changedFiles };
    },

    push: async (workspace, findings) => {
      const pushed = await commitAndPushFromSandbox({
        runGit: workspace.runGit,
        remoteUrl: deps.remoteUrl(),
        workspaceDir: workspace.workspaceDir,
        branchName: deps.branchName,
        commitMessage: `fix: address ${findings.length} review finding(s)`,
        filesToAdd: workspace.changedFiles,
      });
      if (!pushed.ok) {
        return { ok: false, error: pushed.error ?? "the push did not complete" };
      }
      log("Fix cycle", `pushed ${workspace.changedFiles.length} file(s) to '${deps.branchName}'`);
      return { ok: true };
    },

    closeWorkspace: async (workspace) => {
      // The pass owns the sandbox it opened, and releases it on every path. The module calls this in
      // a finally, so a pass that returns early or throws still disposes.
      await workspace.provider.dispose?.();
    },
  });
}

export async function runCodingPhase<T>(
  provider: SandboxProvider,
  workspaceDir: string,
  phase: (tools: WorkspaceTools, provider: SandboxProvider) => Promise<T>,
): Promise<T> {
  const tools = provider.create(workspaceDir);
  try {
    // #354: the phase receives the PROVIDER as well as its tools, because the vault path pushes from
    // INSIDE the phase (this function disposes the sandbox the moment it returns) and `runGit` is a
    // provider capability.
    return await phase(tools, provider);
  } finally {
    await provider.dispose?.();
  }
}

/**
 * Only execute when this file is the entry point.
 *
 * The previous check used the CommonJS `require` identifier, which does not exist inside an ES
 * module. Because this package is `"type": "module"`, evaluating it threw
 * `ReferenceError: require is not defined in ES module scope` at load -- before the check's own
 * `|| process.argv[1]` fallback could take effect -- so the documented
 * `npx tsx scripts/dark-factory-runner.ts` could not start the runner at all.
 *
 * Comparing the module URL with the entry URL behaves identically under tsx, plain node and vitest,
 * so importing this module from a test still does not run `main`.
 */
/**
 * #376 — end a run that failed AFTER it was accepted.
 *
 * Extracted from `main`'s coding-phase catch so it is reachable from a test: `main` cannot be
 * called, and the defect this fixes (a failure that skips the terminal lifecycle) lives in that
 * catch rather than in the phase itself. The terminal lifecycle is what releases the run's claim,
 * so skipping it leaves the ticket on `df:running` and the ledger holding a claim no later attempt
 * may adopt.
 */
export async function finalizeCodingPhaseFailure(
  deps: {
    labelWriter: Parameters<typeof applyTerminalLifecycle>[0]["labelWriter"];
    runHistory: Parameters<typeof applyTerminalLifecycle>[0]["runHistory"];
    breaker: { getTripEvents(): readonly TripEvent[] };
  },
  target: { repo: string; issue: number; runId: string },
  error: unknown,
): Promise<void> {
  // #312: a trip halts fail-closed through the SAME terminal path as the runner's other
  // steps, so a tripped run is never silently left running.
  if (error instanceof CircuitTrippedError) {
    const trips = deps.breaker.getTripEvents();
    console.error(
      `[ERROR] Circuit breaker tripped — halting fail-closed: ${JSON.stringify(trips)}`,
    );
    // #313: persist the trip ON THE RUN so it is explainable on the ticket, not only in a
    // log. Honest fail-closed: a ledger outage must never turn a recorded trip into a
    // silent one, so the failure is reported loudly and the run still fails.
    for (const trip of trips) {
      if (trip.limit === undefined) {
        console.error(
          `[WARN] Circuit-breaker trip (${trip.reason}) carried no limit and cannot be ` +
            `recorded machine-readably; refusing to invent one.`,
        );
        continue;
      }
      const recorded = await recordBreakerTrip(deps.runHistory, {
        runId: target.runId,
        trip: {
          reason: trip.reason,
          limit: trip.limit,
          workerMinutes: trip.workerMinutes,
        },
      });
      if (!recorded.ok) {
        console.error(
          `[ERROR] Circuit-breaker trip could not be persisted for ${target.runId}: ${recorded.error}`,
        );
      }
    }
  }
  // #376: the terminal lifecycle is NOT conditional on a trip. ANY failure after the run was
  // accepted must end it: otherwise the ticket stays on `df:running` and the ledger keeps a
  // claim no later attempt may adopt — which is what a TLS push failure did, because
  // `main`'s catch only logs and sets an exit code.
  await applyTerminalLifecycle(
    { labelWriter: deps.labelWriter, runHistory: deps.runHistory },
    { repo: target.repo, issue: target.issue, runId: target.runId, terminalStatus: "failed" },
  );
}

/**
 * #381 R2 AC4 - park the run when the Architect could not justify a target, rather than failing it.
 *
 * A failed run ends the work; a parked run is resumable, and the human's answer may simply be that the shell
 * IS the right target - which a terminal failure would throw away. Only the two reasons that need a human
 * decision are parked; every other failure still fails terminally.
 */
export function parksForUnjustifiableTarget(reason?: string): boolean {
  return reason === "unresolved-surface" || reason === "refused-target";
}

/**
 * Reasons that ask a human for a decision instead of ending the run (#381 R2 Task 8).
 *
 * A plan that never passed validation is answerable by a person: the validation errors are on the ticket.
 * Aborting threw away a run that one sentence of clarification could unblock.
 */
export function parksForHumanDecision(reason?: string): boolean {
  return parksForUnjustifiableTarget(reason) || reason === "plan-invalid";
}

/** The question matching the reason, so a park never asks about a plan that does not exist. */
export function parkQuestionFor(reason?: string): string {
  return reason === "plan-invalid"
    ? PLAN_INVALID_QUESTION
    : TARGET_UNRESOLVED_QUESTION;
}

/**
 * Does this dispatch stop and wait for a human? (#378)
 *
 * True for a fresh run, and TRUE FOR A REVISION: an amended plan is a plan nobody has approved yet, so
 * the run must park again rather than code against it. Only an approval resume falls through to coding.
 * Exported so the property "a revision never reaches the coding phase" is pinned by a test rather than
 * by reading `if` statements.
 */
export function parksForHumanApproval(input: {
  resuming: boolean;
  revision: boolean;
}): boolean {
  if (input.revision) return true;
  return !input.resuming;
}

/**
 * #503 AC5 — release the active run's claim when `main` aborts after the run was accepted.
 *
 * `applyTerminalLifecycle` is what releases the claim: its terminal event is the release, and it is
 * idempotent (a run already finalised by a phase-level catch returns `{applied:false, skipped:true}`
 * rather than double-labelling). Extracted from the entry-point catch so `main`'s abort path is reachable
 * from a test — `main` itself cannot be called.
 *
 * A failure inside the release is REPORTED BUT NEVER THROWN: the abort that caused it is the failure the
 * operator needs to see, and masking it would hide the original cause. The report always names how to
 * retire the claim by hand, so even a broken release leaves the operator a way out.
 */
/**
 * #531 — record what the run cost, so `df_plan_estimate_accuracy` finally has an actual to join on.
 *
 * Reads the run's recorded usage and its own cost events, sums them, and writes the total to the run
 * summary. BEST-EFFORT BY DESIGN: a cost is an observation about a run, not a control over it, so
 * every failure — including an unconfigured store — is reported and the run is unaffected. Exported so
 * both entry paths can call it, and so its behavior is reachable from a test.
 */
/**
 * Record a run the LEDGER never minted (#681), so the history can see that it happened.
 *
 * A no-op when the ledger has a run for this attempt: that run is already the record, and writing a
 * second row for the same issue would trip `df_run_active_issue_uidx`. This fires only on the fallback
 * path, where the runner carried on with the attempt id and did real work nothing could observe.
 *
 * Best-effort and never fatal, exactly like the cost recorder beside it: failing to record a run must
 * not fail the run.
 */
export async function recordRunAttemptSummary(
  active: ActiveRun | null,
  outcome: { status: RunStatus; completedAt: string; iterationCount?: number; prUrl?: string },
): Promise<void> {
  if (!active) return;
  // #681: the decision lives in a pure predicate so it can be asserted without a database. It fails
  // closed, and it refuses to pretend against a store that cannot persist.
  const decision = attemptRecordingDecision({
    storeId: active.runHistory.id,
    ...(active.ledgerRecorded === undefined ? {} : { ledgerRecorded: active.ledgerRecorded }),
  });
  if (!decision.record) {
    if (decision.reason !== undefined) {
      console.warn(`[WARN] This run will not be persisted: ${decision.reason}.`);
      return;
    }
    // #698: the ledger DID mint this run, so there is nothing to mint - but that is not a reason to
    // write nothing. This is the run that most needs its terminal facts: without them the details page
    // shows dashes for the times, zeros for the counters, and "No PR opened yet" for a run that opened
    // one. Update THAT row in place; never mint a second, or `df_run_active_issue_uidx` would reject it.
    try {
      const existing = await active.runHistory.getRun(active.runId);
      if (!existing.ok || !existing.value) return;
      // #699: `main()` returns normally BOTH after successful work and after `parkForApproval()`. The
      // latter has already recorded a `worker.question` and moved the summary to `blocked`, which is
      // deliberately NOT terminal: a blocked run is resumable, and it is what holds the active-issue
      // claim. Overwriting it with a terminal status releases that claim, so an approval resume then
      // refuses with "a resume continues a run that is holding this issue's claim, and none is" - the
      // parked run can never be continued. Preserve the parked state: leave `completedAt` unset so the
      // row stays non-terminal and adoptable by the next delivery.
      const remainsParked = existing.value.status === "blocked";
      const updated = await active.runHistory.recordRunSummary({
        ...existing.value,
        status: remainsParked ? "blocked" : outcome.status,
        stage: remainsParked ? existing.value.stage : "terminal",
        updatedAt: outcome.completedAt,
        ...(remainsParked ? {} : { completedAt: outcome.completedAt }),
        ...(active.startedAt === undefined ? {} : { startedAt: active.startedAt }),
        ...(outcome.iterationCount === undefined ? {} : { iterationCount: outcome.iterationCount }),
        ...(outcome.prUrl === undefined ? {} : { prUrl: outcome.prUrl }),
      });
      if (!updated.ok) {
        console.warn(
          `[WARN] The run's terminal facts could not be recorded (${updated.error ?? "no detail"}); ` +
            "the run itself is unaffected.",
        );
      }
    } catch (error) {
      console.warn(
        `[WARN] The run's terminal facts could not be recorded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return;
  }
  try {
    const result = await active.runHistory.recordRunSummary(
      buildAttemptSummary({
        runId: active.runId,
        repo: active.repo,
        issue: active.issue,
        status: outcome.status,
        createdAt: active.startedAt ?? outcome.completedAt,
        completedAt: outcome.completedAt,
        ...(active.startedAt === undefined ? {} : { startedAt: active.startedAt }),
        ...(outcome.iterationCount === undefined ? {} : { iterationCount: outcome.iterationCount }),
        ...(outcome.prUrl === undefined ? {} : { prUrl: outcome.prUrl }),
      }),
    );
    if (!result.ok) {
      console.warn(
        `[WARN] The run could not be recorded in the history (${result.error ?? "no detail"}); ` +
          "the run itself is unaffected.",
      );
    }
  } catch (error) {
    console.warn(
      `[WARN] The run could not be recorded in the history: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function recordRunCostForRun(
  active: ActiveRun | null,
  env: Record<string, string | undefined>,
): Promise<void> {
  if (!active) return;
  try {
    const result = await recordRunActualCost(
      { runHistory: active.runHistory, usage: createUsageStore(env) },
      active.runId,
    );
    if (!result.ok && result.reason !== "not-measured") {
      console.warn(
        `[WARN] The run's cost could not be recorded (${result.reason}): ${result.error ?? "no detail"}`,
      );
    }
  } catch (error) {
    console.warn(
      `[WARN] The run's cost could not be recorded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * #533 — the repository's finished runs, for the plan estimate to calibrate against.
 *
 * BEST-EFFORT by design: a plan must never fail because its calibration history was unavailable, so any
 * failure warns and yields an empty window, which is exactly the cold start the estimator already
 * handles. Read here rather than inside the estimator, which stays pure.
 */
export async function readPlanHistory(
  store: RunHistoryStore,
  repo: string,
): Promise<RunSummary[]> {
  try {
    const page = await store.listRuns({
      repo,
      statuses: [...FINISHED_RUN_STATUSES],
      limit: PLAN_HISTORY_WINDOW,
      direction: "desc",
    });
    if (!page.ok) {
      console.warn(
        `[WARN] The plan's calibration history could not be read, so the estimate is a cold start: ${
          page.error ?? "unknown"
        }`,
      );
      return [];
    }
    return selectPlanHistory(page.value?.items ?? []);
  } catch (error) {
    console.warn(
      `[WARN] The plan's calibration history could not be read, so the estimate is a cold start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

export async function releaseAbandonedRunClaim(active: ActiveRun | null): Promise<void> {
  // No run, or a run that aborted before its label writer existed: nothing can be released.
  if (!active || !active.labelWriter) return;

  try {
    await applyTerminalLifecycle(
      { labelWriter: active.labelWriter, runHistory: active.runHistory },
      {
        repo: active.repo,
        issue: active.issue,
        runId: active.runId,
        terminalStatus: "failed",
      },
    );
  } catch (releaseError) {
    console.error(
      `[ERROR] Failed to release the claim for run ${active.runId}: ` +
        `${releaseError instanceof Error ? releaseError.message : String(releaseError)}. ` +
        `Retire it with: npm run df:retire-claim -- --repo ${active.repo} --issue ${active.issue}`,
    );
    return;
  }

  console.error(
    `[ERROR] The run aborted after acceptance; released the claim on ` +
      `${active.repo}#${active.issue} (run ${active.runId}).`,
  );
}

/**
 * Should this dispatch record a plan row and its estimate (#487)?
 *
 * The plan is NEW when the run is a fresh dispatch or a revision round. A plain RESUME reuses the
 * approved plan, which was already recorded when it was first posted, so recomputing and
 * re-persisting there would write a second estimate for a plan nobody re-planned - the thing AC5
 * forbids.
 *
 * The truth table happens to match `parksForHumanApproval` today, because a new plan is exactly what
 * gets parked for review. The two are kept SEPARATE on purpose: they answer different questions, and
 * a future change to who parks must not silently change what gets recorded.
 */
export function shouldRecordPlanEstimate(input: {
  resuming: boolean;
  revision: boolean;
}): boolean {
  if (input.revision) return true;
  return !input.resuming;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main()
    .then(async () => {
      // #531: recorded on the normal path too, so a parked or completed run still carries its cost.
      await recordRunCostForRun(activeRun, process.env);
      // #681: a run the ledger never minted is recorded here, as its own TERMINAL row. `succeeded`
      // because the run delivered what it set out to - a run that PARKED delivered its plan.
      await recordRunAttemptSummary(activeRun, {
        status: "succeeded",
        completedAt: new Date().toISOString(),
      });
    })
    .catch(async (error: unknown) => {
    console.error(
      `[ERROR] Runner aborted: ${error instanceof Error ? error.message : String(error)}`,
    );
    // #531: an aborted run spent money too — before the claim is released and the run is cleared.
    await recordRunCostForRun(activeRun, process.env);
    // #681: an aborted run happened too, and is recorded before the run is cleared.
    await recordRunAttemptSummary(activeRun, {
      status: "aborted",
      completedAt: new Date().toISOString(),
    });
    // #503 AC5: an abort that escaped `main` must still END the run, or the issue keeps the claim (and
    // the `df:running` label) with nothing left to release it. Done BEFORE the control store closes, and
    // it never throws, so the original abort stays the visible cause.
    await releaseAbandonedRunClaim(activeRun);
    try {
      await activeControlStore?.close?.();
    } catch (closeError) {
      console.error(
        `[ERROR] Failed to close control store: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
      );
    } finally {
      activeControlStore = null;
      activeRun = null;
      process.exitCode = 1;
    }
  });
}


/**
 * #704 - adapt the sandbox's git seam to the capture's contract.
 *
 * The two are the same operation under different names: `SandboxProvider.runGit` returns `{ exitCode, output }`
 * (sandbox.ts:21) and `diff-capture`'s `GitRunner` returns `{ stdout, exitCode }`. `tsc` caught this as a type error
 * where a source-grep wiring guard had reported the call as present and correctly ordered - which is why that guard
 * is only ever defensible alongside the compiler and the suite.
 *
 * Adapting rather than casting keeps each side's contract its own: the capture never learns about sandboxes, and the
 * sandbox never learns about diffs.
 */
function gitRunnerForCapture(
  runGit: (args: string[]) => Promise<{ exitCode: number; output: string }>,
): GitRunner {
  return async (args: string[]) => {
    const { exitCode, output } = await runGit(args);
    return { stdout: output, exitCode };
  };
}

/**
 * #764 - record the cases the run ACTUALLY executed, parsed from the gate's own output.
 *
 * Replaces the behavior at this step: `recordPassingTestResults` recorded a passing result for every criterion the
 * plan mapped, which is how a `done` verdict could certify criteria whose tests were never written. The evidence now
 * comes from the run's own output through the seam in `test-case-evidence`, so a criterion whose named case is absent
 * is simply not certified - and the Definition of Done already refuses when a criterion is uncertified.
 *
 * Unreadable output records NOTHING rather than a guess, and a case the output never attributed to a file is skipped
 * rather than attributed to one: no evidence is not a pass, and an unattributed case cannot honestly certify a
 * criterion mapped to a specific file.
 */
export function recordExecutedTestResults(
  output: string | undefined,
  capturedTestResults: { testFile: string; testCaseName: string; passed: boolean }[],
): void {
  for (const executed of parseExecutedTestCases(output ?? "")) {
    if (executed.file === undefined) continue;
    capturedTestResults.push({
      testFile: executed.file,
      testCaseName: executed.name,
      passed: executed.passed,
    });
  }
}
