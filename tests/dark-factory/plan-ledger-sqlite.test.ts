import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";
import type { RunSummary } from "../../agent/lib/dark-factory/run-history";

const at = "2026-10-26T12:00:00.000Z";
const directories: string[] = [];
const stores: SqliteRunHistoryStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "df-plan-ledger-"));
  directories.push(directory);
  const store = new SqliteRunHistoryStore(join(directory, "runs.sqlite"));
  stores.push(store);
  return store;
}

function plan(): ExecutionPlan {
  return {
    storyId: 486,
    title: "persist the estimate",
    summary: "a story",
    targetFiles: [{ path: "a.ts", action: "modify", rationale: "r" }],
    acceptanceCriteriaMap: [],
  };
}

function estimateFor(planId: number) {
  return {
    planId,
    runId: "run-1",
    period: "2026-10",
    model: "deepseek/deepseek-v4.1-flash",
    lowUsd: 0.01,
    expectedUsd: 0.02352,
    highUsd: 0.04704,
    costClass: "XS" as const,
    confidence: "low" as const,
    revisionFactor: 1,
    historySamples: 0,
    targetFileCount: 2,
    taskCount: 0,
    inputTokens: 12_000,
    outputTokens: 8_000,
    priceSource: "known-model",
    features: { targetFileCount: 2, priceSource: "known-model" },
    createdAt: at,
  };
}

describe("plan ledger on sqlite (#486)", () => {
  it("keeps every plan revision, ordered", async () => {
    const store = createStore();
    await store.recordPlan({ runId: "run-1", planRevision: 2, storyId: 486, source: "amendment", plan: plan(), createdAt: at });
    await store.recordPlan({ runId: "run-1", planRevision: 1, storyId: 486, source: "architect", plan: plan(), createdAt: at });

    const plans = await store.listPlans("run-1");
    // A column could hold only one of these. The trajectory across revisions is the point.
    expect(plans.map((p) => p.planRevision)).toEqual([1, 2]);
    expect(plans.map((p) => p.source)).toEqual(["architect", "amendment"]);
    expect(plans[0].plan.targetFiles).toHaveLength(1);
  });

  it("round-trips the band, class, confidence, features and version", async () => {
    const store = createStore();
    const recorded = await store.recordPlan({ runId: "run-1", planRevision: 1, storyId: 486, source: "architect", plan: plan(), createdAt: at });
    const written = await store.recordPlanEstimate(estimateFor(recorded.planId));

    expect(written.estimateId).toBeGreaterThan(0);
    expect(written.estimatorVersion).toBe("v1");

    const [stored] = await store.listPlanEstimates("run-1");
    expect(stored.expectedUsd).toBeCloseTo(0.02352, 8);
    expect(stored.costClass).toBe("XS");
    expect(stored.confidence).toBe("low");
    expect(stored.features).toEqual({ targetFileCount: 2, priceSource: "known-model" });
    expect(stored.estimatorVersion).toBe("v1");
    // Whole-run for now: no stage until per-stage attribution lands (#492).
    expect(stored).not.toHaveProperty("stage");
  });

  it("leaves an unpriced plan with NO estimate row rather than a zero-filled one", async () => {
    const store = createStore();
    await store.recordPlan({ runId: "run-2", planRevision: 1, storyId: 486, source: "architect", plan: plan(), createdAt: at });

    const estimates = await store.listPlanEstimates("run-2");
    expect(estimates).toEqual([]);
  });

  it("reports a signed error from the accuracy view", async () => {
    const store = createStore();
    const summary: RunSummary = {
      runId: "run-3",
      repo: "owner/repo",
      issue: 486,
      status: "succeeded",
      stage: "terminal",
      createdAt: at,
      updatedAt: at,
      startedAt: at,
      completedAt: at,
      attemptCount: 1,
      reviewCount: 0,
      iterationCount: 1,
      fixCycleCount: 0,
      costUsd: 0.05,
    };
    await store.recordRunSummary(summary);
    const recorded = await store.recordPlan({ runId: "run-3", planRevision: 1, storyId: 486, source: "architect", plan: plan(), createdAt: at });
    await store.recordPlanEstimate({ ...estimateFor(recorded.planId), runId: "run-3" });

    const rows = await store.listEstimateAccuracy("2026-10");
    expect(rows).toHaveLength(1);
    expect(rows[0].actualUsd).toBeCloseTo(0.05, 8);
    // Forecast below actual is a NEGATIVE signed error: understating is the bias to catch.
    expect(rows[0].signedErrorUsd).toBeCloseTo(0.02352 - 0.05, 8);
  });

  it("adds the tables to a database created before #486, keeping its rows readable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "df-plan-legacy-"));
    directories.push(directory);
    const legacyPath = join(directory, "legacy.sqlite");

    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`CREATE TABLE df_run_summaries (
      run_id TEXT PRIMARY KEY, repo TEXT NOT NULL, issue INTEGER NOT NULL,
      status TEXT NOT NULL, stage TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
      attempt_count INTEGER NOT NULL, review_count INTEGER NOT NULL,
      iteration_count INTEGER NOT NULL, fix_cycle_count INTEGER NOT NULL,
      latency_ms REAL, cost_usd REAL, pr_url TEXT, git_diff TEXT, tenant_id TEXT
    );`);
    legacy
      .prepare(
        `INSERT INTO df_run_summaries (
           run_id, repo, issue, status, stage, created_at, updated_at, started_at,
           completed_at, attempt_count, review_count, iteration_count, fix_cycle_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-run", "owner/repo", 486, "succeeded", "terminal", at, at, at, at, 1, 0, 1, 0);
    legacy.close();

    const store = new SqliteRunHistoryStore(legacyPath);
    stores.push(store);

    // The pre-existing row survives, and the new tables exist and answer.
    const existing = await store.getRun("legacy-run");
    expect(existing.ok).toBe(true);
    expect(existing.value?.runId).toBe("legacy-run");
    expect(await store.listPlans("legacy-run")).toEqual([]);
  });
});
