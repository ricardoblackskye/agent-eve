/**
 * #492 — an architect planning call records a usage event, so planning spend becomes separable from
 * implementation spend in the usage ledger.
 *
 * The sink is a NARROW structural contract (the shape `developer-agent.ts` already exposes as `WorkerUsageSink`),
 * so this seam needs no store dependency, and recording is BEST-EFFORT: a ledger failure must never fail the call
 * it measures. Recording is scoped to the call site that supplies a sink, which is how the developer and tester
 * paths keep writing exactly what they wrote before.
 */
import { describe, expect, it } from "vitest";
import { InMemoryCostBudgetProvider } from "../../agent/lib/dark-factory/cost-budget-store";
import { createCostGovernor } from "../../agent/lib/dark-factory/cost-governor";
import {
  CostRefusedError,
  runGovernedAgentCall,
} from "../../agent/lib/dark-factory/governed-agent-call";

const MODEL = "deepseek/deepseek-chat";
const ENV: Record<string, string | undefined> = { DF_COST_BUDGET_ARCHITECT_USD: "5" };

type Measurement = {
  taskType?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
};

/** Captures what the seam hands the sink, so the assertion is about the RECORD, not a mock's shape. */
function capturingSink() {
  const seen: Measurement[] = [];
  return {
    seen,
    sink: {
      record: async (measurement?: Measurement): Promise<boolean> => {
        seen.push(measurement ?? {});
        return true;
      },
    },
  };
}

function architectGovernor() {
  return createCostGovernor(new InMemoryCostBudgetProvider(), ENV);
}

describe("#492 a governed call records usage when a sink is supplied", () => {
  it("records ONE event, tagged with the call's task type and the measured tokens", async () => {
    const { seen, sink } = capturingSink();
    const result = await runGovernedAgentCall(
      { governor: architectGovernor() },
      {
        category: "architect",
        model: MODEL,
        inputTokens: 1_000,
        outputTokens: 1_000,
        run: async () => ({ text: "plan", tokensIn: 1_234, tokensOut: 567, costUsd: 0.02 }),
        usage: {
          taskType: "architect",
          sink,
          measurementOf: (r) => ({
            tokensIn: r.tokensIn,
            tokensOut: r.tokensOut,
            costUsd: r.costUsd,
          }),
        },
      },
    );

    expect(result.text).toBe("plan");
    expect(seen).toHaveLength(1);
    expect(seen[0].taskType).toBe("architect");
    expect(seen[0].tokensIn).toBe(1_234);
    expect(seen[0].tokensOut).toBe(567);
    expect(seen[0].costUsd).toBeCloseTo(0.02);
  });

  it("records nothing when no sink is supplied (the opt-in default)", async () => {
    const { seen } = capturingSink();
    const result = await runGovernedAgentCall(
      { governor: architectGovernor() },
      {
        category: "architect",
        model: MODEL,
        inputTokens: 1_000,
        outputTokens: 1_000,
        run: async () => "plan",
      },
    );

    expect(result).toBe("plan");
    expect(seen).toHaveLength(0);
  });

  it("records even when NO governor is configured: budget and usage are separate subsystems", async () => {
    const { seen, sink } = capturingSink();
    const result = await runGovernedAgentCall(
      {},
      {
        category: "architect",
        model: MODEL,
        inputTokens: 1_000,
        outputTokens: 1_000,
        run: async () => "plan",
        usage: { taskType: "architect", sink },
      },
    );

    expect(result).toBe("plan");
    expect(seen).toHaveLength(1);
    expect(seen[0].taskType).toBe("architect");
  });

  // --- Task 4: the Review Focus cases. Each locks in behaviour the seam must keep, so a later refactor cannot
  // quietly drop it: telemetry never fails a call, a refused call is not attributed, and nothing is invented.

  it("does not fail the call when the SINK itself throws", async () => {
    const exploding = {
      record: async (): Promise<boolean> => {
        throw new Error("ledger exploded");
      },
    };
    const result = await runGovernedAgentCall(
      { governor: architectGovernor() },
      {
        category: "architect",
        model: MODEL,
        inputTokens: 1_000,
        outputTokens: 1_000,
        run: async () => "plan",
        usage: { taskType: "architect", sink: exploding },
      },
    );

    // The call's result is what matters; the ledger failure is logged, never thrown at the caller.
    expect(result).toBe("plan");
  });

  it("records NOTHING when the cost gate refuses the call: nothing ran, so nothing is attributed", async () => {
    const { seen, sink } = capturingSink();
    await expect(
      runGovernedAgentCall(
        { governor: architectGovernor() },
        {
          category: "architect",
          model: MODEL,
          inputTokens: 0,
          outputTokens: 100_000_000,
          run: async () => "should not run",
          usage: { taskType: "architect", sink },
        },
      ),
    ).rejects.toBeInstanceOf(CostRefusedError);

    expect(seen).toHaveLength(0);
  });

  it("records an unmeasured event when the call RAN and threw, and still rethrows", async () => {
    const { seen, sink } = capturingSink();
    await expect(
      runGovernedAgentCall(
        { governor: architectGovernor() },
        {
          category: "architect",
          model: MODEL,
          inputTokens: 1_000,
          outputTokens: 1_000,
          run: async () => {
            throw new Error("provider exploded");
          },
          usage: { taskType: "architect", sink },
        },
      ),
    ).rejects.toThrow("provider exploded");

    // The spend happened even though there is no measurement (the governor settles the reservation on a throw),
    // so the ledger acknowledges the call rather than staying silent.
    expect(seen).toHaveLength(1);
    expect(seen[0].taskType).toBe("architect");
    expect(seen[0].tokensIn).toBeUndefined();
  });

  it("hands the sink ONLY what was measured, never an invented zero", async () => {
    const { seen, sink } = capturingSink();
    await runGovernedAgentCall(
      { governor: architectGovernor() },
      {
        category: "architect",
        model: MODEL,
        inputTokens: 1_000,
        outputTokens: 1_000,
        run: async () => ({ output: "plan" }),
        usage: { taskType: "architect", sink, measurementOf: () => ({}) },
      },
    );

    // The ledger reports an absent measurement as `unmeasured`; writing 0 would read as "this call was free".
    expect(Object.keys(seen[0])).toEqual(["taskType"]);
  });
});
