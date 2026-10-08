/**
 * #270 — a governed agent call refuses at the call site AND records the code on the run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCostBudgetProvider, type CostBudgetStore } from "../../agent/lib/dark-factory/cost-budget-store";
import { createCostGovernor } from "../../agent/lib/dark-factory/cost-governor";
import {
  CostRefusedError,
  runGovernedAgentCall,
} from "../../agent/lib/dark-factory/governed-agent-call";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const MODEL = "deepseek/deepseek-chat";
const ENV: Record<string, string | undefined> = { DF_COST_BUDGET_DEVELOPER_USD: "5" };

const stores: SqliteRunHistoryStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

function governor(store: CostBudgetStore = new InMemoryCostBudgetProvider()) {
  return { governor: createCostGovernor(store, ENV), store };
}

describe("#270 runGovernedAgentCall", () => {
  it("runs the call unchanged when no governor is configured (opt-in)", async () => {
    const run = vi.fn(async () => "done");
    const out = await runGovernedAgentCall({}, {
      category: "developer", model: MODEL, inputTokens: 1, outputTokens: 1, run,
    });
    expect(out).toBe("done");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs and returns the result when admitted", async () => {
    const { governor: g } = governor();
    const run = vi.fn(async () => "ok");
    const out = await runGovernedAgentCall({ governor: g }, {
      category: "developer", model: MODEL, inputTokens: 1_000, outputTokens: 1_000, run,
    });
    expect(out).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("REFUSES at the call site and does NOT run an over-budget call", async () => {
    const { governor: g } = governor();
    const run = vi.fn(async () => "should not run");

    await expect(
      runGovernedAgentCall({ governor: g }, {
        category: "developer", model: MODEL, inputTokens: 0, outputTokens: 100_000_000, run,
      }),
    ).rejects.toBeInstanceOf(CostRefusedError);
    expect(run).not.toHaveBeenCalled();
  });

  it("records the refusal CODE on the run", async () => {
    const history = new SqliteRunHistoryStore(":memory:", () => "run-gov");
    stores.push(history);
    await history.acceptDelivery({
      deliveryId: "d-gov", repo: "ricardoblackskye/agent-eve", issue: 270, receivedAt: new Date().toISOString(),
    });
    const { governor: g } = governor();

    await expect(
      runGovernedAgentCall({ governor: g, runHistory: history, runId: "run-gov" }, {
        category: "developer", model: MODEL, inputTokens: 0, outputTokens: 100_000_000,
        run: async () => "nope",
      }),
    ).rejects.toBeInstanceOf(CostRefusedError);

    const events = await history.listRunEvents("run-gov");
    const terminal = events.value?.items.find((i) => i.event.type === "run.terminal");
    expect(terminal?.event.costRefusal).toBe("budget_exceeded");
  });

  it("still refuses (and does not crash) when there is no run to record on", async () => {
    const { governor: g } = governor();
    await expect(
      runGovernedAgentCall({ governor: g }, {
        category: "developer", model: "unknown/model", inputTokens: 1, outputTokens: 1,
        run: async () => "nope",
      }),
    ).rejects.toMatchObject({ reason: "unpriced_model" });
  });
});
