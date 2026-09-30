import { describe, expect, it } from "vitest";
import {
  WORKER_COST_CATEGORY_VAR,
  WORKER_COST_ENABLED_VAR,
  WORKER_COST_PERIOD_VAR,
  buildWorkerCostEnv,
} from "../agent/lib/dark-factory/worker-cost-env";

describe("worker cost-budget env contract", () => {
  it("is null when governance is disabled, so the worker is unchanged", () => {
    expect(buildWorkerCostEnv("developer", {})).toBeNull();
    expect(
      buildWorkerCostEnv("developer", { DF_COST_BUDGET_DRIVER: "console" }),
    ).toBeNull();
  });

  it("carries the category and governance flag when a backend is configured", () => {
    const contract = buildWorkerCostEnv("tester", {
      DF_COST_BUDGET_DRIVER: "postgres",
      DF_COST_BUDGET_DATABASE_URL: "postgresql://example",
      DF_COST_BUDGET_PERIOD: "2026-02",
    });
    expect(contract).not.toBeNull();
    expect(contract!.category).toBe("tester");
    expect(contract!.env[WORKER_COST_CATEGORY_VAR]).toBe("tester");
    expect(contract!.env[WORKER_COST_ENABLED_VAR]).toBe("true");
    expect(contract!.env[WORKER_COST_PERIOD_VAR]).toBe("2026-02");
  });

  it("never leaks a database URL or credential into the sandbox contract", () => {
    const contract = buildWorkerCostEnv("developer", {
      DF_COST_BUDGET_DRIVER: "postgres",
      DF_COST_BUDGET_DATABASE_URL: "postgresql://user:secret@host/db",
    });
    const serialised = JSON.stringify(contract);
    expect(serialised).not.toContain("secret");
    expect(serialised).not.toContain("postgresql://");
  });
});