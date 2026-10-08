/**
 * #269 — End-to-end pipeline integration test (issue -> PR).
 *
 * Proves the Dark Factory pipeline end to end with a Mock-GitHub, composing the
 * REAL modules:
 *
 *   decideDarkFactoryTrigger  ->  runDarkFactoryDispatch  ->  Dispatcher
 *     ->  createDispatchHandler(developer -> tester -> pr)  ->  PR OPENED (never merged)
 *
 * SCOPE (agreed at review): the pipeline is proven up to "PR opened (not merged)".
 * The terminal lifecycle labels (`df:done`/`df:failed`) are applied by NO library
 * module today (df:done only in scripts/dark-factory-runner.ts; df:failed nowhere),
 * so their wiring is filed separately as #284 — not asserted here.
 *
 * External edges are mocked exactly as the repo already does elsewhere: the GitHub
 * label writer and the session handoff are recorders; run history and dispatch state
 * are real in-memory SQLite; the LLM, the tester's command runner, and the PR opener
 * are injected stubs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideDarkFactoryTrigger, TRIGGER_LABELS } from "../../agent/lib/dark-factory/trigger";
import {
  runDarkFactoryDispatch,
  type EntryDeps,
  type LabelWriter,
} from "../../agent/lib/dark-factory/entry";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { SqliteStateAdapter } from "../../agent/lib/dark-factory/state";
import { Dispatcher, toDispatchEvent } from "../../agent/lib/dark-factory/dispatch";
import {
  createDispatchHandler,
  type FactoryStages,
} from "../../agent/lib/dark-factory/dispatch-handler";
import { createWorkspaceTools, runMultiFileCodingLoop } from "../../agent/lib/dark-factory/developer-agent";
import { TesterAgent, toValidationRequest, type CommandRunner } from "../../agent/lib/dark-factory/tester-agent";
import {
  runDefinitionOfDone,
  type DefinitionOfDoneDeps,
  type DefinitionOfDoneTask,
  type PrOpener,
  type PrCommentWriter,
} from "../../agent/lib/dark-factory/definition-of-done";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";
import { GitHubPrWriter } from "../../agent/lib/dark-factory/pr-writer";

// --- helpers (mirror tests/dark-factory/entry.test.ts) ---------------------------------

const historyStores: SqliteRunHistoryStore[] = [];
const stateStores: SqliteStateAdapter[] = [];
let runIdCount = 0;

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "df-pipeline-269-"));
});

afterEach(async () => {
  for (const s of historyStores.splice(0)) await s.close();
  for (const s of stateStores.splice(0)) s.close?.();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

/** A recording fetch standing in for the session handoff. */
function recordingPost() {
  const calls: { url: string; body: string }[] = [];
  const impl = (async (url: unknown, init: { body?: string } = {}) => {
    calls.push({ url: String(url), body: String(init.body ?? "") });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A recording GitHub label writer (the Mock-GitHub label edge). */
function recordingLabels() {
  const ops: string[] = [];
  const writer: LabelWriter = {
    add: async (_repo, _issue, label) => {
      ops.push(`+${label}`);
      return { ok: true };
    },
    remove: async (_repo, _issue, label) => {
      ops.push(`-${label}`);
      return { ok: true };
    },
  };
  return { writer, ops };
}

const ENV = {
  DF_TRIGGER_LABEL: "dark-factory",
  DF_WORKER_ALLOWED_REPOS: "ricardoblackskye/agent-eve",
  DF_TRIGGER_ALLOWED_USERS: "ricardoblackskye",
};

const REPO = "ricardoblackskye/agent-eve";

function triggerPayload(over: Record<string, unknown> = {}) {
  return {
    action: "labeled",
    label: { name: "dark-factory" },
    sender: { login: "ricardoblackskye" },
    repository: { full_name: REPO },
    issue: { number: 269, title: "Prove the pipeline", body: "Intent: prove it." },
    ...over,
  } as never;
}

const PLAN: ExecutionPlan = {
  storyId: 269,
  title: "Prove the pipeline end to end",
  summary: "Wire the Dark Factory pipeline and open a PR",
  targetFiles: [{ path: "app/feature.ts", action: "create", rationale: "the feature" }],
  acceptanceCriteriaMap: [
    {
      acId: "AC1",
      description: "the feature exists",
      testFile: "tests/feature.test.ts",
      testCaseName: "it works",
    },
  ],
};

/** A tester command runner that returns every check as passing. */
const passingRunner: CommandRunner = async () => ({ exitCode: 0, stdout: "ok", stderr: "" });

// --- the pipeline ---------------------------------------------------------------------

describe("#269 end-to-end pipeline (issue -> PR)", () => {
  it("drives trigger -> entry -> dispatcher -> handler -> PR opened, in order", async () => {
    // 1. TRIGGER — a labelled issue is decided as a trigger.
    const decision = decideDarkFactoryTrigger(triggerPayload(), ENV);
    expect(decision.kind).toBe("trigger");

    // 2. ENTRY — record the run, apply df:running, hand off out of band.
    const runHistory = new SqliteRunHistoryStore(":memory:", () => `run-269-${++runIdCount}`);
    historyStores.push(runHistory);
    const { impl: postSession, calls: postCalls } = recordingPost();
    const { writer: labels, ops: labelOps } = recordingLabels();
    const entryDeps: EntryDeps = {
      runHistory,
      deliveryId: "delivery-269",
      postSession,
      labels,
      origin: "http://localhost:3000",
    };
    const dispatched = await runDarkFactoryDispatch(decision, entryDeps);
    expect(dispatched).toMatchObject({ ok: true, status: "dispatched" });
    expect(labelOps).toEqual([`+${TRIGGER_LABELS.running}`]);
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0].url).toMatch(/\/eve\/v1\/session$/);
    const runId = dispatched.runId as string;
    expect(runId).toBeTruthy();

    // 3. DISPATCHER + HANDLER — developer -> tester -> pr, over the real agents.
    const order: string[] = [];
    const tools = createWorkspaceTools(tempDir);

    const testerAgent = new TesterAgent({}, { commandRunner: passingRunner });
    const prCalls: { owner: string; repo: string; options: Record<string, unknown> }[] = [];
    const prWriter: PrOpener = {
      createPullRequest: async (owner, repo, options) => {
        prCalls.push({ owner, repo, options: options as unknown as Record<string, unknown> });
        return {
          ok: true,
          status: 201,
          pr: {
            number: 2690,
            url: "https://github.com/ricardoblackskye/agent-eve/pull/2690",
            head: options.head,
            base: options.base ?? "main",
            title: options.title,
            body: options.body,
          },
        };
      },
    };
    const commentWriter: PrCommentWriter = { postComment: async () => ({ ok: true }) };
    const dodDeps: DefinitionOfDoneDeps = {
      prWriter,
      commentWriter,
      runChecks: async () => [],
    };
    const dodTask: DefinitionOfDoneTask = {
      runId,
      repo: REPO,
      issue: 269,
      head: "feat/df-pipeline-e2e-269",
      title: "feat(df): prove the pipeline",
      body: "Closes #269",
      plan: PLAN,
      // The DoD verifies each mapped AC against observed test results; the
      // developer stage's tests are represented as passing here.
      testResults: PLAN.acceptanceCriteriaMap.map((ac) => ({
        testFile: ac.testFile,
        testCaseName: ac.testCaseName,
        passed: true,
      })),
    };

    const stages: FactoryStages = {
      developer: async () => {
        order.push("developer");
        const loop = await runMultiFileCodingLoop({
          plan: PLAN,
          tools,
          maxIterations: 1,
          worker: async (c) => {
            for (const file of c.plan.targetFiles) {
              await c.tools.writeFile(file.path, "// implemented by the developer stage\n");
            }
            return { passed: true };
          },
        });
        if (loop.status !== "success") throw new Error("developer loop did not pass");
      },
      tester: async () => {
        order.push("tester");
        const report = await testerAgent.runValidation(toValidationRequest({ branch: dodTask.head }));
        return report.overall === "pass"
          ? { passed: true }
          : { passed: false, reason: `gate ${report.overall}` };
      },
      pr: async () => {
        order.push("pr");
        const dod = await runDefinitionOfDone(dodDeps, dodTask);
        if (!dod.ok) throw new Error(`definition of done failed: ${dod.reason}`);
      },
    };

    const store = new SqliteStateAdapter(":memory:");
    stateStores.push(store);
    let handlerRuns = 0;
    const dispatcher = new Dispatcher({
      store,
      handler: async (event, worker, checkpoint) => {
        handlerRuns += 1;
        return createDispatchHandler({ stages })(event, worker, checkpoint);
      },
      sleep: async () => {},
    });

    const outcome = await dispatcher.dispatch(
      toDispatchEvent({ runId, repo: REPO, ref: "main", status: "success" }),
    );

    // 4. ASSERT the whole chain.
    expect(outcome.status).toBe("succeeded");
    expect(outcome.attempts).toBe(1);
    expect(order).toEqual(["developer", "tester", "pr"]);
    // The developer actually wrote the planned file.
    expect(await tools.readFile("app/feature.ts")).toContain("implemented by the developer stage");
    // The PR was opened exactly once.
    expect(prCalls).toHaveLength(1);
    expect(prCalls[0]).toMatchObject({ owner: "ricardoblackskye", repo: "agent-eve" });
    expect(prCalls[0].options).toMatchObject({ head: "feat/df-pipeline-e2e-269", base: "main" });
  });
});

describe("#269 the terminal-label guard prevents a second run", () => {
  for (const terminal of [TRIGGER_LABELS.done, TRIGGER_LABELS.failed]) {
    it(`does not start a run when the issue already carries '${terminal}'`, async () => {
      const decision = decideDarkFactoryTrigger(
        triggerPayload({ issue: { number: 269, labels: [{ name: terminal }] } }),
        ENV,
      );
      expect(decision.kind).toBe("not-a-trigger");

      const runHistory = new SqliteRunHistoryStore(":memory:", () => `run-guard-${++runIdCount}`);
      historyStores.push(runHistory);
      const { impl: postSession, calls: postCalls } = recordingPost();
      const { writer: labels, ops: labelOps } = recordingLabels();
      const result = await runDarkFactoryDispatch(decision, {
        runHistory,
        deliveryId: "delivery-guard",
        postSession,
        labels,
        origin: "http://localhost:3000",
      });

      expect(result).toMatchObject({ ok: true, status: "ignored" });
      expect(labelOps).toEqual([]);
      expect(postCalls).toEqual([]);
      const runs = await runHistory.listRuns();
      expect(runs.value?.items ?? []).toHaveLength(0);
    });
  }

  it("holds a re-delivered trigger as a duplicate (no second run)", async () => {
    const runHistory = new SqliteRunHistoryStore(":memory:", () => `run-dup-${++runIdCount}`);
    historyStores.push(runHistory);
    const { impl: postSession } = recordingPost();
    const { writer: labels } = recordingLabels();
    const deps: EntryDeps = {
      runHistory,
      deliveryId: "delivery-dup",
      postSession,
      labels,
      origin: "http://localhost:3000",
    };
    const decision = decideDarkFactoryTrigger(triggerPayload(), ENV);

    const first = await runDarkFactoryDispatch(decision, deps);
    const second = await runDarkFactoryDispatch(decision, deps);

    expect(first.status).toBe("dispatched");
    expect(second.status).toBe("held");
  });
});

describe("#269 the PR is opened but never merged", () => {
  it("the PR writer exposes no merge verb", () => {
    const proto = GitHubPrWriter.prototype as unknown as Record<string, unknown>;
    expect(proto.merge).toBeUndefined();
    expect(proto.mergePullRequest).toBeUndefined();
  });
});
