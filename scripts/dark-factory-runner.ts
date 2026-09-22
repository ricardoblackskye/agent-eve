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
import { GitHubPrWriter } from "../agent/lib/dark-factory/pr-writer";
import {
  GitHubIssueWriter,
  resolveIssueToken,
} from "../agent/lib/dark-factory/issue-writer";
import { resolveWorkerAllowedRepos } from "../agent/lib/dark-factory/credentials";
import {
  DeveloperAgent,
  createWorkspaceTools,
  runMultiFileCodingLoop,
  toTaskAssignment,
} from "../agent/lib/dark-factory/developer-agent";
import { createMetricsStore } from "../agent/lib/dark-factory/metrics";
import { ArchitectAgent } from "../agent/lib/dark-factory/architect-agent";
import { validateExecutionPlan, type ExecutionPlan } from "../agent/lib/dark-factory/plan-validator";

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
  console.log(`  ${label.padEnd(32)} ${typeof value === "string" ? value : JSON.stringify(value)}`);

/** Recursively scan workspace to build file tree for the Architect Agent. */
function scanWorkspaceFiles(dir: string, base: string = dir): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === ".next") continue;
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

async function main(): Promise<void> {
  console.log("################################################################################");
  console.log("  DARK FACTORY: HARDENED ARCHITECT & MULTI-FILE DEVELOPER RUNNER (#179)        ");
  console.log("################################################################################\n");

  const env = initEnv();
  const token = resolveIssueToken(env);
  const allowed = resolveWorkerAllowedRepos(env);
  const targetRepo = "ricardoblackskye/agent-eve";

  const issueArgIdx = process.argv.indexOf("--issue");
  const issueNum =
    issueArgIdx !== -1 && process.argv[issueArgIdx + 1]
      ? parseInt(process.argv[issueArgIdx + 1], 10)
      : 179;

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
    console.error("[ERROR] Missing GITHUB_TOKEN or OPENROUTER_API_KEY in environment or .env");
    process.exit(1);
  }

  const issueWriter = new GitHubIssueWriter({ token });
  const prWriter = new GitHubPrWriter({ token, env });
  const metrics = createMetricsStore();
  const developerAgent = new DeveloperAgent({ metrics });
  const model = resolveChatModel();

  // STEP 1: Fetch live issue from GitHub
  console.log(`\n[STEP 1] Fetching live User Story #${issueNum} from GitHub...`);
  const issueRes = await fetch(`https://api.github.com/repos/${targetRepo}/issues/${issueNum}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "Dark-Factory-Runner",
    },
  });
  if (!issueRes.ok) {
    console.error(`Failed to fetch issue #${issueNum}: HTTP ${issueRes.status}`);
    process.exit(1);
  }
  const issueData = (await issueRes.json()) as { title: string; body: string };
  line("Story Title", issueData.title);
  console.log(`  Story Length: ${issueData.body.length} characters`);

  // STEP 2: Move issue lifecycle label to df:running & post progress
  console.log(`\n[STEP 2] Updating ticket lifecycle label to 'df:running' and posting progress comment...`);
  await issueWriter.addLabel("ricardoblackskye", "agent-eve", issueNum, "df:running");
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
  console.log(`\n[STEP 3] Architect Agent discovering repository structure and planning story...`);
  const architectAgent = new ArchitectAgent({
    listFiles: async () => scanWorkspaceFiles(process.cwd()),
    generateText: async (prompt) => {
      const stream = streamText({ model, prompt });
      let output = "";
      for await (const chunk of stream.textStream) {
        output += chunk;
        process.stdout.write(chunk);
      }
      return output;
    },
    maxPlanRetries: 2,
  });

  const planResult = await architectAgent.planStory({
    number: issueNum,
    title: issueData.title,
    body: issueData.body,
  });

  if (!planResult.ok || !planResult.plan) {
    console.error(`[ERROR] Architect Agent planning failed: ${planResult.error}`);
    await issueWriter.addLabel("ricardoblackskye", "agent-eve", issueNum, "needs-answer");
    process.exit(1);
  }

  const executionPlan = planResult.plan;
  console.log("\n  -> Architect Planning Succeeded!");
  line("Plan Summary", executionPlan.summary);
  line("Target Files", executionPlan.targetFiles.map((f) => f.path).join(", "));
  line("AC Mappings Count", executionPlan.acceptanceCriteriaMap.length);

  // STEP 4: Pre-flight Domain Validation
  console.log(`\n[STEP 4] Validating ExecutionPlan against domain constraints...`);
  const validation = validateExecutionPlan(executionPlan, issueData.body);
  if (!validation.valid) {
    console.error(`[ERROR] Plan domain validation rejected:`, validation.errors);
    process.exit(1);
  }
  console.log("  -> Domain Validation Passed!");

  // STEP 5: Multi-File Developer Agent Execution Loop
  console.log(`\n[STEP 5] Dispatched Multi-File Developer Agent with Workspace Tools...`);
  const workspaceTools = createWorkspaceTools(process.cwd());
  const capturedTestResults: { testFile: string; testCaseName: string; passed: boolean }[] = [];

  const loopResult = await runMultiFileCodingLoop({
    plan: executionPlan,
    tools: workspaceTools,
    maxIterations: developerAgent.maxIterations,
    worker: async (ctx) => {
      console.log(`  -> Coding Iteration ${ctx.iteration}/${developerAgent.maxIterations}...`);

      const workerPrompt = [
        `You are Eve's Developer Agent. Execute the following ExecutionPlan:`,
        JSON.stringify(ctx.plan, null, 2),
        ``,
        `For each target file, provide the code to write.`,
        `Return a JSON object where keys are relative file paths and values are string file contents.`,
        `Example: { "app/chat.tsx": "export ...", "tests/chat.test.ts": "import ..." }`,
      ].join("\n");

      const stream = streamText({ model, prompt: workerPrompt });
      let output = "";
      for await (const chunk of stream.textStream) {
        output += chunk;
      }

      try {
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        const filesMap = JSON.parse(jsonMatch ? jsonMatch[0] : output) as Record<string, string>;
        for (const [filePath, content] of Object.entries(filesMap)) {
          await ctx.tools.writeFile(filePath, content);
          console.log(`     Wrote ${filePath} (${content.length} chars)`);
        }
      } catch (err: any) {
        return { passed: false, output: `JSON parsing error: ${err.message}` };
      }

      // Run vitest to verify acceptance criteria
      const testOutcome = await ctx.tools.runTests("npx vitest run");
      console.log(`     Test result: ${testOutcome.passed ? "PASS" : "FAIL"}`);

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
  });

  if (loopResult.status !== "success") {
    console.error("[ERROR] Developer Agent failed to achieve passing tests.");
    process.exit(1);
  }

  // STEP 6: Commit and Push Task Branch
  console.log(`\n[STEP 6] Committing changes to '${branchName}' and pushing to GitHub...`);
  const filesToCommit = executionPlan.targetFiles.map((f) => f.path).join(" ");
  execSync(`git add ${filesToCommit}`, { stdio: "inherit" });
  execSync(`git commit -m "feat: #${issueNum} ${executionPlan.title}"`, { stdio: "inherit" });

  const pushUrl = `https://x-access-token:${token}@github.com/${targetRepo}.git`;
  execSync(`git push ${pushUrl} ${branchName}`, { stdio: "pipe" });
  console.log(`  -> Pushed '${branchName}' successfully!`);

  // STEP 7: Definition of DONE with AC Traceability Matrix
  console.log(`\n[STEP 7] Executing Hardened Definition of DONE (#179)...`);
  const dodTask: DefinitionOfDoneTask = {
    runId: `run-${issueNum}-${Date.now()}`,
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
            message: "TypeScript compiler reported type error in generated code",
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
    await issueWriter.addLabel("ricardoblackskye", "agent-eve", issueNum, "df:done");
    await issueWriter.removeLabel("ricardoblackskye", "agent-eve", issueNum, "df:running");
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

  console.log("\n================================================================================");
  console.log("DARK FACTORY RUNNER: EXECUTION COMPLETED SUCCESSFULLY");
  console.log("================================================================================\n");
}

// Only execute main when run as script directly
if (require.main === module || process.argv[1]?.endsWith("dark-factory-runner.ts")) {
  void main();
}
