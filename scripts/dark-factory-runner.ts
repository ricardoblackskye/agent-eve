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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import { streamText } from "ai";
import { resolveChatModel } from "../agent/chat-model";
import {
  runDefinitionOfDone,
  type DefinitionOfDoneDeps,
  type DefinitionOfDoneTask,
  type ReviewFinding,
} from "../agent/lib/dark-factory/definition-of-done";
import { applyTerminalLifecycle } from "../agent/lib/dark-factory/run-finalizer";
import { GitHubPrWriter } from "../agent/lib/dark-factory/pr-writer";
import {
  GitHubIssueWriter,
  createGitHubLabelWriter,
  resolveIssueToken,
} from "../agent/lib/dark-factory/issue-writer";
import { resolveWorkerAllowedRepos } from "../agent/lib/dark-factory/credentials";
import {
  CircuitTrippedError,
  DeveloperAgent,
  runMultiFileCodingLoop,
  toTaskAssignment,
  type LoopResult,
} from "../agent/lib/dark-factory/developer-agent";
import { createCircuitBreaker } from "../agent/lib/dark-factory/circuit-breaker";
import { createSandboxProvider } from "../agent/lib/dark-factory/sandbox-provider";
import { reapSandboxesByRun } from "../agent/lib/dark-factory/sandbox-reaper";
import type { SandboxProvider } from "../agent/lib/dark-factory/sandbox";
import type { WorkspaceTools } from "../agent/lib/dark-factory/developer-agent";
import { createCodeAuthorProvider } from "../agent/lib/dark-factory/code-author-provider";
import type { CodeAuthorProvider } from "../agent/lib/dark-factory/code-author";
import { createCodingLoopBreaker } from "../agent/lib/dark-factory/breaker-wiring";
import { recordBreakerTrip } from "../agent/lib/dark-factory/breaker-trip-recorder";
import { createMetricsStore } from "../agent/lib/dark-factory/metrics";
import { ArchitectAgent } from "../agent/lib/dark-factory/architect-agent";
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
import { createCostGovernor } from "../agent/lib/dark-factory/cost-governor";
import { createRunHistoryStore } from "../agent/lib/dark-factory/run-history-provider";
import { beginRunRecord } from "../agent/lib/dark-factory/run-record";
import { withNotifications } from "../agent/lib/dark-factory/notifying-run-history";
import { runGovernedAgentCall } from "../agent/lib/dark-factory/governed-agent-call";

// Load .env variables into process.env
function initEnv(): Record<string, string | undefined> {
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        process.env[key] = val;
      }
    }
  }
  if (!process.env.DF_WORKER_ALLOWED_REPOS) {
    process.env.DF_WORKER_ALLOWED_REPOS = "ricardoblackskye/agent-eve";
  }
  if (!process.env.EVE_CHAT_MODEL) {
    process.env.EVE_CHAT_MODEL = "deepseek/deepseek-chat";
  }
  return process.env;
}

initEnv();

const line = (label: string, value: unknown) =>
  console.log(
    `  ${label.padEnd(32)} ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );

/** Recursively scan workspace to build file tree for the Architect Agent. */
function scanWorkspaceFiles(dir: string, base: string = dir): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === ".next")
        continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...scanWorkspaceFiles(full, base));
      } else {
        results.push(relative(base, full).replace(/\\/g, "/"));
      }
    }
  } catch {
    // Ignore unreadable dirs
  }
  return results;
}

let activeControlStore: ControlStore | null = null;

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

  const env = initEnv();
  const token = resolveIssueToken(env);
  const allowed = resolveWorkerAllowedRepos(env);
  const targetRepo = "ricardoblackskye/agent-eve";

  const issueArgIdx = process.argv.indexOf("--issue");
  const issueNum =
    issueArgIdx !== -1 && process.argv[issueArgIdx + 1]
      ? parseInt(process.argv[issueArgIdx + 1], 10)
      : 179;

  const attemptId = resolveRunnerRunId(process.argv, issueNum);

  // #316: open the run's record FIRST, through the existing seam, and adopt the id the ledger
  // mints. The LEDGER owns run identity — it is idempotent per delivery, so re-running the same
  // attempt is a no-op — and adopting its id is what makes the run appear in the dashboard and
  // addressable by its control actions. An unconfigured ledger is reported loudly and the attempt
  // id is used as a fallback, so a local run still works.
  const runHistory = withNotifications(createRunHistoryStore(env), env);
  const begun = await beginRunRecord({
    history: runHistory,
    attemptId,
    repo: targetRepo,
    issue: issueNum,
  });
  const runId = begun.runId;

  const { store: runControlStore, checkpoint } = buildRunControl(env, runId);
  activeControlStore = runControlStore;
  await checkpoint();

  const branchArgIdx = process.argv.indexOf("--branch");
  const branchName =
    branchArgIdx !== -1 && process.argv[branchArgIdx + 1]
      ? process.argv[branchArgIdx + 1]
      : `feat/dark-factory-#${issueNum}`;

  line("Target Repository", targetRepo);
  line("Allowed Repositories", allowed);
  line("Target Issue", `#${issueNum}`);
  line("Configured Chat Model", env.EVE_CHAT_MODEL);
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
  const prWriter = new GitHubPrWriter({ token, env });
  const metrics = createMetricsStore();
  const developerAgent = new DeveloperAgent({ metrics });
  const model = resolveChatModel();
  const modelId = env.EVE_CHAT_MODEL ?? "deepseek/deepseek-chat";

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
  await issueWriter.addLabel(
    "ricardoblackskye",
    "agent-eve",
    issueNum,
    "df:running",
  );
  await issueWriter.postComment(
    "ricardoblackskye",
    "agent-eve",
    issueNum,
    `🤖 **Eve** (Dark Factory) — Dispatched Hardened Pipeline on #${issueNum}\n\n` +
      `- **Task Branch**: \`${branchName}\`\n` +
      `- **Assigned Agents**: Architect Agent & Multi-File Developer Agent (Model: \`${env.EVE_CHAT_MODEL}\`)\n` +
      `- **Status**: Synthesizing ExecutionPlan and running pre-flight domain validation...`,
  );

  // STEP 3: Architect Agent Planning Phase
  console.log(
    `\n[STEP 3] Architect Agent discovering repository structure and planning story...`,
  );
  const architectAgent = new ArchitectAgent({
    listFiles: async () => scanWorkspaceFiles(process.cwd()),
    generateText: async (prompt) => {
      await checkpoint();
      // Governed (#270): an over-budget call is refused at THIS call site, and the
      // refusal code is recorded on the run.
      return runGovernedAgentCall(
        { governor, runHistory, runId },
        {
          category: "developer",
          model: modelId,
          inputTokens: Math.ceil(prompt.length / 4),
          outputTokens: 8_000,
          run: async () => {
            const stream = streamText({ model, prompt });
            let output = "";
            for await (const chunk of stream.textStream) {
              output += chunk;
              process.stdout.write(chunk);
            }
            return output;
          },
        },
      );
    },
    maxPlanRetries: 2,
  });

  const planResult = await architectAgent.planStory({
    number: issueNum,
    title: issueData.title,
    body: issueData.body,
  });
  await checkpoint();

  if (!planResult.ok || !planResult.plan) {
    console.error(
      `[ERROR] Architect Agent planning failed: ${planResult.error}`,
    );
    await issueWriter.addLabel(
      "ricardoblackskye",
      "agent-eve",
      issueNum,
      "needs-answer",
    );
    await applyTerminalLifecycle(
      { labelWriter, runHistory },
      { repo: targetRepo, issue: issueNum, runId, terminalStatus: "failed" },
    );
    throw new Error("Dark Factory Runner stopped after the preceding error.");
  }

  const executionPlan = planResult.plan;
  console.log("\n  -> Architect Planning Succeeded!");
  line("Plan Summary", executionPlan.summary);
  line("Target Files", executionPlan.targetFiles.map((f) => f.path).join(", "));
  line("AC Mappings Count", executionPlan.acceptanceCriteriaMap.length);

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

  let loopResult: LoopResult;
  try {
    loopResult = await runCodingPhase(
      createSandboxProvider(undefined, undefined, runId),
      process.cwd(),
      async (workspaceTools) =>
        runMultiFileCodingLoop({
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
            let authored: { files: Record<string, string>; raw: string };
            try {
              authored = await authorFiles(codeAuthor, ctx.plan, ctx.tools);
            } catch (err: any) {
              return {
                passed: false,
                output: `Authoring error: ${err.message}`,
              };
            }
            for (const [filePath, content] of Object.entries(authored.files)) {
              console.log(`     Wrote ${filePath} (${content.length} chars)`);
            }

            // Run vitest to verify acceptance criteria
            const testOutcome = await ctx.tools.runTests("npx vitest run");
            console.log(
              `     Test result: ${testOutcome.passed ? "PASS" : "FAIL"}`,
            );

            if (testOutcome.passed) {
              // Record passing test results for each mapped AC
              for (const ac of ctx.plan.acceptanceCriteriaMap) {
                capturedTestResults.push({
                  testFile: ac.testFile,
                  testCaseName: ac.testCaseName,
                  passed: true,
                });
              }
            }

            return { passed: testOutcome.passed, output: testOutcome.output };
          },
        }),
    );
  } catch (error) {
    // #312: a trip halts fail-closed through the SAME terminal path as the runner's other
    // steps, so a tripped run is never silently left running.
    if (error instanceof CircuitTrippedError) {
      const trips = breaker.getTripEvents();
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
        const recorded = await recordBreakerTrip(runHistory, {
          runId,
          trip: {
            reason: trip.reason,
            limit: trip.limit,
            workerMinutes: trip.workerMinutes,
          },
        });
        if (!recorded.ok) {
          console.error(
            `[ERROR] Circuit-breaker trip could not be persisted for ${runId}: ${recorded.error}`,
          );
        }
      }
      await applyTerminalLifecycle(
        { labelWriter, runHistory },
        { repo: targetRepo, issue: issueNum, runId, terminalStatus: "failed" },
      );
    }
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
  console.log(
    `\n[STEP 6] Committing changes to '${branchName}' and pushing to GitHub...`,
  );
  const filesToCommit = executionPlan.targetFiles.map((f) => f.path).join(" ");
  await checkpoint();
  execSync(`git add ${filesToCommit}`, { stdio: "inherit" });
  await checkpoint();
  execSync(`git commit -m "feat: #${issueNum} ${executionPlan.title}"`, {
    stdio: "inherit",
  });
  await checkpoint();

  const pushUrl = `https://x-access-token:${token}@github.com/${targetRepo}.git`;
  try {
    execSync(`git push ${pushUrl} ${branchName}`, { stdio: "pipe" });
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
    body: `Autonomous pull request opened by Eve's Developer Agent.\n\nCloses #${issueNum}`,
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
      "ricardoblackskye",
      "agent-eve",
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
}

/**
 * #281 (R2b/B1) — write the authored files into the workspace.
 *
 * The author seam deliberately does NOT write files (it returns the map, keeping the seam pure), so
 * the caller writes them through the SAME workspace tools as before. A failed author propagates: the
 * coding loop records a failed iteration rather than silently writing nothing.
 */
export async function authorFiles(
  author: CodeAuthorProvider,
  plan: unknown,
  tools: { writeFile(relPath: string, content: string): Promise<void> },
): Promise<{ files: Record<string, string>; raw: string }> {
  const result = await author.write({ plan });
  for (const [filePath, content] of Object.entries(result.files)) {
    await tools.writeFile(filePath, content);
  }
  return { files: result.files, raw: result.raw };
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
  phase: (tools: WorkspaceTools) => Promise<T>,
): Promise<T> {
  const tools = provider.create(workspaceDir);
  try {
    return await phase(tools);
  } finally {
    await provider.dispose?.();
  }
}

// Only execute main when run as script directly
if (
  require.main === module ||
  process.argv[1]?.endsWith("dark-factory-runner.ts")
) {
  void main().catch(async (error: unknown) => {
    console.error(
      `[ERROR] Runner aborted: ${error instanceof Error ? error.message : String(error)}`,
    );
    try {
      await activeControlStore?.close?.();
    } catch (closeError) {
      console.error(
        `[ERROR] Failed to close control store: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
      );
    } finally {
      activeControlStore = null;
      process.exitCode = 1;
    }
  });
}
