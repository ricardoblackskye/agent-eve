/**
 * #492 — planning spend must be separable from implementation spend in the usage ledger, provable END TO END:
 * the governed seam → the real best-effort sink → a real store → the query.
 *
 * The aggregation itself is already covered (`usage-task-type.test.ts`: task-type buckets, and an unmeasured sum
 * staying absent rather than 0). What this file adds is the WIRING #492 delivered, against a real store rather than
 * a stub — a stub would prove the assertion and nothing about the seam.
 *
 * The sink is built from the SAME classes the runner's factory builds (`WorkerUsageRecorder` over a
 * `BufferedUsageRecorder` over the sqlite store), but with a store this test owns, because a file-backed
 * `node:sqlite` handle locks its file on Windows: the store must be CLOSED before the temp directory is removed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCostBudgetProvider } from "../../agent/lib/dark-factory/cost-budget-store";
import { createCostGovernor } from "../../agent/lib/dark-factory/cost-governor";
import { runGovernedAgentCall } from "../../agent/lib/dark-factory/governed-agent-call";
import { queryUsage } from "../../agent/lib/dark-factory/usage-query";
import { BufferedUsageRecorder, type UsageStore } from "../../agent/lib/dark-factory/usage-store";
import { createUsageStore } from "../../agent/lib/dark-factory/usage-store-provider";
import { WorkerUsageRecorder } from "../../agent/lib/dark-factory/worker-usage";

const MODEL = "deepseek/deepseek-chat";
const RUN_ID = "run-492-architect";
const BUDGET_ENV: Record<string, string | undefined> = { DF_COST_BUDGET_ARCHITECT_USD: "5" };

const openStores: UsageStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real sqlite ledger, plus the sink the runner's factory would build for one task type. */
function realLedger() {
  const dir = mkdtempSync(join(tmpdir(), "usage-492-"));
  dirs.push(dir);
  const env: Record<string, string | undefined> = {
    DF_USAGE_DRIVER: "sqlite",
    DF_USAGE_DB_PATH: join(dir, "usage.sqlite"),
  };
  const store = createUsageStore(env);
  openStores.push(store);
  const sinkFor = (taskType: string) =>
    new WorkerUsageRecorder(new BufferedUsageRecorder(store), { runId: RUN_ID, model: MODEL });
  return { store, architect: sinkFor("architect"), developer: sinkFor("developer") };
}

describe("#492 architect spend is separable per run", () => {
  it("records the architect call through the real sink, and reports it under its own task type", async () => {
    const { store, architect } = realLedger();

    const result = await runGovernedAgentCall(
      { governor: createCostGovernor(new InMemoryCostBudgetProvider(), BUDGET_ENV) },
      {
        category: "architect",
        model: MODEL,
        inputTokens: 1_000,
        outputTokens: 1_000,
        run: async () => ({ output: "plan", tokensIn: 900, tokensOut: 300, durationMs: 1_500 }),
        usage: {
          taskType: "architect",
          sink: architect,
          measurementOf: (attempt) => ({
            tokensIn: attempt.tokensIn,
            tokensOut: attempt.tokensOut,
            durationMs: attempt.durationMs,
          }),
        },
      },
    );
    expect(result.output).toBe("plan");

    const query = await queryUsage(store, { runId: RUN_ID });
    expect(query.ok).toBe(true);
    if (!query.ok) return;

    const row = query.report.byTaskType.find((entry) => entry.taskType === "architect");
    expect(row, "the architect call must appear under its own task type").toBeDefined();
    expect(row?.calls).toBe(1);
    expect(row?.tokensIn).toBe(900);
    expect(row?.tokensOut).toBe(300);
    expect(row?.durationMs).toBe(1_500);
    // An unpriced model yields NO cost rather than 0, so this is asserted as "measured or absent", never zero.
    expect(row?.costUsd === undefined || row.costUsd > 0).toBe(true);
  });

  it("leaves the developer row to the developer path (AC3)", async () => {
    const { store, architect, developer } = realLedger();

    await runGovernedAgentCall(
      { governor: createCostGovernor(new InMemoryCostBudgetProvider(), BUDGET_ENV) },
      {
        category: "architect",
        model: MODEL,
        inputTokens: 1_000,
        outputTokens: 1_000,
        run: async () => ({ output: "plan", tokensIn: 900, tokensOut: 300, durationMs: 1_500 }),
        usage: {
          taskType: "architect",
          sink: architect,
          measurementOf: (attempt) => ({ tokensIn: attempt.tokensIn, tokensOut: attempt.tokensOut }),
        },
      },
    );

    // The developer path records its own way, with the task type it has always used.
    await developer.record({ taskType: "developer", tokensIn: 10, tokensOut: 5, costUsd: 0.25 });

    const query = await queryUsage(store, { runId: RUN_ID });
    expect(query.ok).toBe(true);
    if (!query.ok) return;

    const byType = new Map(query.report.byTaskType.map((entry) => [entry.taskType, entry]));
    expect(byType.get("architect")?.calls).toBe(1);
    expect(byType.get("architect")?.tokensIn).toBe(900);
    expect(byType.get("developer")?.calls).toBe(1);
    expect(byType.get("developer")?.tokensIn).toBe(10);
    expect(byType.get("developer")?.costUsd).toBeCloseTo(0.25);
    // The architect's tokens must never leak into the developer row — the point of the change.
    expect(byType.get("developer")?.tokensIn).not.toBe(900);
  });
});
