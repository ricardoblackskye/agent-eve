/**
 * #487 AC4 - the estimate reaching PERSISTENCE, through the real store.
 *
 * The wiring tests assert the payload handed to a fake ledger, which proves the mapping but not the
 * write path. This drives the actual SqliteRunHistoryStore and reads the rows back, so a column the
 * adapter rejects or a field it silently drops fails here rather than in a deploy.
 *
 * It is also where the write-once guard is proven against a real constraint rather than a fake: the
 * ledger refuses a second plan row for the same (run, revision), which is the second line of defence
 * behind the resume predicate.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { PLAN_ESTIMATOR_VERSION } from "../../agent/lib/dark-factory/plan-cost-estimate";
import { recordPlanWithEstimateSafely } from "../../agent/lib/dark-factory/plan-estimate-recorder";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

const directories: string[] = [];
const stores: SqliteRunHistoryStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): SqliteRunHistoryStore {
  const directory = mkdtempSync(join(tmpdir(), "df-plan-estimate-"));
  directories.push(directory);
  const store = new SqliteRunHistoryStore(join(directory, "runs.sqlite"));
  stores.push(store);
  return store;
}

/** The validated-plan shape the ledger's own validator accepts. */
function plan(): ExecutionPlan {
  return {
    storyId: 487,
    title: "wire the estimate",
    summary: "a story",
    targetFiles: [{ path: "a.ts", action: "modify", rationale: "r" }],
    acceptanceCriteriaMap: [],
  };
}

function input(over: Record<string, unknown> = {}) {
  return {
    plan: plan(),
    runId: "run-487",
    model: "deepseek/deepseek-v4.1-flash",
    period: "2026-10",
    planRevision: 1,
    storyId: 487,
    source: "architect" as const,
    now: new Date("2026-10-27T12:00:00.000Z"),
    commentRef: { provider: "github" as const, id: 4242, url: "https://example.invalid/4242" },
    ...over,
  };
}

describe("#487 AC4 the estimate reaches persistence", () => {
  it("writes the plan and its estimate, and reads both back", async () => {
    const store = createStore();
    const result = await recordPlanWithEstimateSafely(store, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const plans = await store.listPlans("run-487");
    expect(plans).toHaveLength(1);
    expect(plans[0].planRevision).toBe(1);
    expect(plans[0].source).toBe("architect");
    expect(plans[0].commentRef?.id).toBe(4242);
    expect(plans[0].plan.title).toBe("wire the estimate");

    const estimates = await store.listPlanEstimates("run-487");
    expect(estimates).toHaveLength(1);
    const row = estimates[0];
    // the child points at the parent the store actually assigned, not one we guessed
    expect(row.planId).toBe(plans[0].planId);
    expect(row.runId).toBe("run-487");
    expect(row.period).toBe("2026-10");
    expect(row.estimatorVersion).toBe(PLAN_ESTIMATOR_VERSION);
    expect(row.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(row.expectedUsd).toBeGreaterThan(0);
    expect(row.lowUsd).toBeLessThan(row.expectedUsd);
    expect(row.highUsd).toBeGreaterThan(row.expectedUsd);
    // the typed columns survived the round trip, derived from the estimator's features
    expect(row.targetFileCount).toBe(1);
    expect(row.priceSource).toBe("known-model");
    expect(row.features.priceSource).toBe("known-model");
    expect(row.createdAt).toBe("2026-10-27T12:00:00.000Z");
    expect(row.stage).toBeUndefined();
  });

  it("refuses a second plan for the same revision by throwing (write-once refusal is a real error, #505)", async () => {
    const store = createStore();
    const first = await recordPlanWithEstimateSafely(store, input());
    expect(first.ok).toBe(true);

    // A resume that wrongly recorded again would land here. The write-once constraint refuses it, and
    // because the plan row is owned by recordPostedPlan (#505), that refusal PROPAGATES (fail-closed)
    // rather than being swallowed as a best-effort observation. The resume predicate is the real guard;
    // this proves a bypass still cannot sneak a duplicate past the ledger.
    await expect(recordPlanWithEstimateSafely(store, input())).rejects.toThrow();
    expect(await store.listPlans("run-487")).toHaveLength(1);
    expect(await store.listPlanEstimates("run-487")).toHaveLength(1);
  });

  it("records a REVISION as its own plan row, with its own estimate", async () => {
    const store = createStore();
    await recordPlanWithEstimateSafely(store, input());
    const revision = await recordPlanWithEstimateSafely(
      store,
      input({ planRevision: 2, source: "amendment" }),
    );
    expect(revision.ok).toBe(true);

    const plans = await store.listPlans("run-487");
    expect(plans.map((p) => p.planRevision)).toEqual([1, 2]);
    expect(plans[1].source).toBe("amendment");
    const estimates = await store.listPlanEstimates("run-487");
    expect(estimates).toHaveLength(2);
    expect(new Set(estimates.map((e) => e.planId)).size).toBe(2);
  });
});
