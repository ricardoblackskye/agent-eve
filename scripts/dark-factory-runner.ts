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
} from "../agent/lib/dark-factory/definition-of-done";
import {
  applyStartLifecycle,
  applyTerminalLifecycle,
} from "../agent/lib/dark-factory/run-finalizer";
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
} from "../agent/lib/dark-factory/git-push";
import { DEFAULT_SANDBOX_WORKSPACE } from "../agent/lib/dark-factory/opensandbox-driver";
import {
  CircuitTrippedError,
  DeveloperAgent,
  runMultiFileCodingLoop,
  toTaskAssignment,
  type LoopResult,
} from "../agent/lib/dark-factory/developer-agent";
import {
  createCircuitBreaker,
  type TripEvent,
} from "../agent/lib/dark-factory/circuit-breaker";
import { createSandboxProvider } from "../agent/lib/dark-factory/sandbox-provider";
import { reapSandboxesByRun } from "../agent/lib/dark-factory/sandbox-reaper";
import type { SandboxProvider } from "../agent/lib/dark-factory/sandbox";
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
import { createUsageStore } from "../agent/lib/dark-factory/usage-store-provider";
import {
  FINISHED_RUN_STATUSES,
  PLAN_HISTORY_WINDOW,
  selectPlanHistory,
} from "../agent/lib/dark-factory/plan-history";
import type { RunSummary } from "../agent/lib/dark-factory/run-history";
import type { RunHistoryStore } from "../agent/lib/dark-factory/run-history-store";

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
    history: runHistory,
    attemptId,
    repo: targetRepo,
    issue: issueNum,
  });
  // #373: a run the ledger refused because ANOTHER run holds this issue must not start. The previous
  // behaviour carried on with the attempt id as a synthetic run id, so its lifecycle writes targeted a run
  // the ledger had never minted - the stale claim kept the issue and nothing could release it.
  // #373: a FRESH run refused because another run holds this issue must not start. The old behaviour
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
  activeRun = { repo: targetRepo, issue: issueNum, runId, runHistory };

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
  const issueData = (await issueRes.json()) as { title: string; body: string };
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
    { repo: targetRepo, issue: issueNum },
  );
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

    const amendedValidation = validateExecutionPlan(amended.plan, issueData.body);
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

  // STEP 4: Pre-flight Domain Validation
  console.log(
    `\n[STEP 4] Validating ExecutionPlan against domain constraints...`,
  );
  const validation = validateExecutionPlan(executionPlan, issueData.body);
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
  // #280: the execution backend is configuration-selected. Unset DF_SANDBOX_DRIVER = the local
  // filesystem, i.e. today's behaviour; an unknown value throws before any side effect.
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
          });
          if (!prepared.ok) {
            throw new Error(
              `sandbox repository preparation failed: ${prepared.error}`,
            );
          }
        }
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

            console.log(
              `     Test result: ${testOutcome.passed ? "PASS" : "FAIL"}`,
            );

            if (testOutcome.passed) {
              // #503 AC4: record a passing result for each mapped AC. The map is typed as required but a
              // deserialized plan may omit it (the architect returned one without it at STEP 3.5), so
              // iterate the fallback, not the field directly.
              recordPassingTestResults(ctx.plan, capturedTestResults);
            }

            return { passed: testOutcome.passed, output: testOutcome.output };
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
  const dodTask: DefinitionOfDoneTask = {
    runId,
    repo: targetRepo,
    issue: issueNum,
    head: branchName,
    base: "main",
    title: `feat: #${issueNum} ${executionPlan.title}`,
    body: pullRequestBody({
      issueNum,
      planPath: planArtifactPath,
      repo: targetRepo,
      branch: branchName,
    }),
    plan: executionPlan,
    testResults: capturedTestResults,
  };

  const dodDeps: DefinitionOfDoneDeps = {
    prWriter,
    commentWriter: {
      postComment: async (owner, repo, prNum, body) => {
        const res = await issueWriter.postComment(owner, repo, prNum, body);
        return { ok: res.ok, error: res.error };
      },
    },
    runChecks: async () => {
      try {
        execSync("npx tsc --noEmit", { stdio: "pipe" });
        return [];
      } catch {
        return [
          {
            id: "TYPE-CHECK-FAIL",
            source: "linter",
            message:
              "TypeScript compiler reported type error in generated code",
            severity: "error",
          },
        ];
      }
    },
  };

  const dodResult = await runDefinitionOfDone(dodDeps, dodTask);
  line("DoD Status", dodResult.status);
  line("Is DONE (ok)", dodResult.ok);
  line("AC Matrix Count", dodResult.acMatrix?.length ?? 0);

  if (dodResult.pr) {
    line("Live PR URL", dodResult.pr.url);
    await applyTerminalLifecycle(
      { labelWriter, runHistory },
      {
        repo: targetRepo,
        issue: issueNum,
        runId,
        terminalStatus: "succeeded",
        dodResult,
      },
    );
    await issueWriter.postComment(
      repoOwner,
      repoName,
      issueNum,
      `🤖 **Eve** (Dark Factory) — Story #${issueNum} Completed with Verified Traceability ✅\n\n` +
        `- **PR**: ${dodResult.pr.url}\n` +
        `- **Traceability Matrix**:\n\n${dodResult.traceabilityTable ?? "Verified"}\n` +
        `- **Lifecycle**: \`df:done\``,
    );
  }

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
 * IS handed to the next iteration as `feedback` (#373 - that sentence described intent, not behaviour, until the loop's context carried it).
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
  return { files: result.files, raw: result.raw, written, skipped };
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
 * #503 AC4 — record a passing result for each acceptance criterion the plan mapped to a test.
 *
 * `ExecutionPlan.acceptanceCriteriaMap` is typed as required, but a deserialized plan may omit it (the
 * architect returned one without it at STEP 3.5), and iterating the field directly threw "Cannot read
 * properties of undefined" at the coding phase. This mirrors the renderer's tolerance from the same
 * issue: a recording layer must not depend on another guard to avoid a TypeError. Exported so the
 * "a plan without the map does not crash the coding phase" property is pinned by a test.
 */
export function recordPassingTestResults(
  plan: {
    acceptanceCriteriaMap?: ReadonlyArray<{ testFile: string; testCaseName: string }> | null;
  },
  capturedTestResults: { testFile: string; testCaseName: string; passed: boolean }[],
): void {
  const mappings = plan.acceptanceCriteriaMap ?? [];
  for (const ac of mappings) {
    capturedTestResults.push({
      testFile: ac.testFile,
      testCaseName: ac.testCaseName,
      passed: true,
    });
  }
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
 * both entry paths can call it, and so its behaviour is reachable from a test.
 */
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
    })
    .catch(async (error: unknown) => {
    console.error(
      `[ERROR] Runner aborted: ${error instanceof Error ? error.message : String(error)}`,
    );
    // #531: an aborted run spent money too — before the claim is released and the run is cleared.
    await recordRunCostForRun(activeRun, process.env);
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
