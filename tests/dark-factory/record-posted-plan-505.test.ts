/**
 * #505 — the runner's post-plan step must PERSIST the plan to `df_plans`.
 *
 * The runner posted the plan as a GitHub comment but never called `runHistory.recordPlan(...)`, so
 * `df_plans` stayed empty even with a configured store. The only plan write was `recordPlanRevision`
 * on the resume branch, which appends a `run.resumed` EVENT, not a plan row.
 *
 * `recordPostedPlan` is the coerced, single-call seam: it records the plan AND honours the store's
 * contract — the refusing console/dry-run store is skipped LOUDLY (never a silent no-op), while any
 * other failure (a real DB/misconfig error) still surfaces.
 */
import { describe, expect, it } from "vitest";
import { recordPostedPlan } from "../../agent/lib/dark-factory/plan-revision-recorder";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { createRunHistoryStore } from "../../agent/lib/dark-factory/run-history-provider";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

const RUN_ID = "run-505";
const PLAN = {
  storyId: 173,
  targetFiles: [],
  summary: "wire the plan",
} as unknown as ExecutionPlan;

describe("#505 record the posted plan to df_plans", () => {
  it("records the posted plan on the real store", async () => {
    const store = new SqliteRunHistoryStore(":memory:");

    const result = await recordPostedPlan(store, {
      runId: RUN_ID,
      planRevision: 1,
      plan: PLAN,
      source: "architect",
    });

    expect(result.ok).toBe(true);
    expect(typeof result.planId).toBe("number");

    const plans = await store.listPlans(RUN_ID);
    expect(plans).toHaveLength(1);
    expect(plans[0].storyId).toBe(173);
    expect(plans[0].source).toBe("architect");
    expect(plans[0].planRevision).toBe(1);
    expect(plans[0].plan).toBeTruthy();
  });

  it("records the revision it is given, so a re-plan lands its own row", async () => {
    const store = new SqliteRunHistoryStore(":memory:");

    await recordPostedPlan(store, {
      runId: RUN_ID,
      planRevision: 1,
      plan: PLAN,
      source: "architect",
    });
    await recordPostedPlan(store, {
      runId: RUN_ID,
      planRevision: 2,
      plan: PLAN,
      source: "amendment",
    });

    const plans = await store.listPlans(RUN_ID);
    expect(plans.map((plan) => plan.planRevision)).toEqual([1, 2]);
    expect(plans[1].source).toBe("amendment");
  });

  it("skips LOUDLY (no throw) on the refusing dry-run store", async () => {
    const dryRun = createRunHistoryStore({});

    const result = await recordPostedPlan(dryRun, {
      runId: RUN_ID,
      planRevision: 1,
      plan: PLAN,
      source: "architect",
    });

    // Not a silent no-op: the caller can see the plan was NOT persisted.
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toMatch(/not configured/i);
  });

  it("fails CLOSED: a non-configuration error propagates", async () => {
    const broken = {
      recordPlan: async () => {
        throw new Error("ledger is down");
      },
    } as unknown as RunHistoryStore;

    await expect(
      recordPostedPlan(broken, {
        runId: RUN_ID,
        planRevision: 1,
        plan: PLAN,
        source: "architect",
      }),
    ).rejects.toThrow("ledger is down");
  });
});
