/**
 * #505 — the runner's post-plan step must PERSIST the plan to `df_plans`.
 *
 * The runner posted the plan as a GitHub comment but never called `runHistory.recordPlan(...)`, so
 * `df_plans` stayed empty even with a configured store. The only plan write was `recordPlanRevision`
 * on the resume branch, which appends a `run.resumed` EVENT, not a plan row.
 *
 * `recordPostedPlan` is the coerced, single-call seam: it records the plan AND honours the store's
 * contract — the refusing console/dry-run store is skipped LOUDLY (never a silent no-op), while any
 * other failure (a real DB/misconfiguration error) still surfaces.
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

describe("a re-recorded plan revision is a duplicate, not a failure (#516)", () => {
  const basePlan = {
    storyId: 516,
    title: "a re-recorded revision",
    summary: "identical means identical",
    targetFiles: [{ path: "a.ts", action: "modify" as const, rationale: "the file that changes" }],
    tasks: [{ title: "one", objective: "do one thing" }],
    acceptanceCriteriaMap: [],
  } as unknown as ExecutionPlan;

  async function runInStore() {
    const history = new SqliteRunHistoryStore(":memory:", () => "run-516");
    const accepted = await history.acceptDelivery({
      deliveryId: `d-${Math.random().toString(16).slice(2)}`,
      repo: "owner/repo",
      issue: 516,
      receivedAt: "2026-10-29T10:00:00.000Z",
    });
    return { history, runId: accepted.value?.runId as string };
  }

  it("treats an identical re-record as a DUPLICATE SUCCESS, writing nothing new", async () => {
    const { history, runId } = await runInStore();
    const first = await recordPostedPlan(history, {
      runId,
      planRevision: 1,
      plan: basePlan,
      source: "architect",
    });
    expect(first.ok).toBe(true);

    const second = await recordPostedPlan(history, {
      runId,
      planRevision: 1,
      plan: basePlan,
      source: "architect",
    });

    // The call was HANDLED and changed nothing — a success, not a refusal.
    expect(second.ok).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.planId).toBe(first.planId);
    // And the ledger still holds exactly one plan: the whole write is idempotent, not half of it.
    expect(await history.listPlans(runId)).toHaveLength(1);
    await history.close();
  });

  it("still PROPAGATES a different plan at the same revision, so the abort stays reachable", async () => {
    const { history, runId } = await runInStore();
    await recordPostedPlan(history, { runId, planRevision: 1, plan: basePlan, source: "architect" });

    await expect(
      recordPostedPlan(history, {
        runId,
        planRevision: 1,
        plan: { ...basePlan, summary: "a genuinely different plan" } as ExecutionPlan,
        source: "architect",
      }),
    ).rejects.toThrow();
    await history.close();
  });

  it("ignores the DERIVED commentRef, so a re-post with a new reference is the same plan", async () => {
    const { history, runId } = await runInStore();
    await recordPostedPlan(history, {
      runId,
      planRevision: 1,
      plan: basePlan,
      source: "architect",
      commentRef: { provider: "github", id: 1, url: "https://github.com/owner/repo/issues/516#issuecomment-1" },
    });

    const second = await recordPostedPlan(history, {
      runId,
      planRevision: 1,
      plan: basePlan,
      source: "architect",
      commentRef: { provider: "github", id: 2, url: "https://github.com/owner/repo/issues/516#issuecomment-2" },
    });

    // GitHub derives the reference AFTER the record is written, so it must not make one plan look like two.
    expect(second.duplicate).toBe(true);
    expect(await history.listPlans(runId)).toHaveLength(1);
    await history.close();
  });
});

describe("samePlan (#516)", () => {
  const plan = (overrides: Record<string, unknown> = {}) =>
    ({
      storyId: 516,
      title: "t",
      summary: "s",
      targetFiles: [{ path: "a.ts", action: "modify", rationale: "r" }],
      tasks: [{ title: "one", objective: "o" }],
      acceptanceCriteriaMap: [],
      ...overrides,
    }) as unknown as ExecutionPlan;

  it("matches an identical plan", () => {
    expect(samePlan(plan(), plan())).toBe(true);
  });

  it("does NOT match a changed summary, task or target file", () => {
    expect(samePlan(plan(), plan({ summary: "other" }))).toBe(false);
    expect(samePlan(plan(), plan({ tasks: [{ title: "two", objective: "o" }] }))).toBe(false);
    expect(samePlan(plan(), plan({ targetFiles: [{ path: "b.ts", action: "modify", rationale: "r" }] }))).toBe(false);
  });

  it("does NOT match a changed rationale, which is the part a human reads", () => {
    expect(
      samePlan(plan(), plan({ targetFiles: [{ path: "a.ts", action: "modify", rationale: "different" }] })),
    ).toBe(false);
  });

  it("matches the same plan when its keys come back REORDERED, as postgres jsonb returns them (#516)", () => {
    // Found against the real store: jsonb does not preserve key order, so a round-tripped plan is the same
    // plan with its fields in a different order. sqlite stores text and keeps the order, which is exactly
    // how this hid behind a green local suite.
    const reordered = {
      acceptanceCriteriaMap: [],
      summary: "s",
      title: "t",
      tasks: [{ title: "one", objective: "o" }],
      targetFiles: [{ path: "a.ts", action: "modify", rationale: "r" }],
      storyId: 516,
    } as unknown as ExecutionPlan;
    expect(samePlan(plan(), reordered)).toBe(true);
  });

  it("ignores the comment reference, mirroring sameEvent", () => {
    expect(samePlan(plan({ commentRef: { provider: "github", id: 1, url: "u" } }), plan())).toBe(true);
  });
});
import { samePlan } from "../../agent/lib/dark-factory/plan-revision-recorder";
