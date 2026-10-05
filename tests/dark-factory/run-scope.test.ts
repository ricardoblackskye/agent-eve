import { describe, expect, it } from "vitest";
import type { RunSummary } from "../../agent/lib/dark-factory/run-history";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import {
  isRunVisible,
  queryRunDetailFromParams,
  queryRunListFromParams,
  queryRunMetricsFromParams,
  type RunScope,
} from "../../agent/lib/dark-factory/run-query";

const TENANT_A = "11111111-2222-4333-8444-555555555555";
const TENANT_B = "66666666-7777-4888-8999-000000000000";

const CUSTOMER_A: RunScope = { role: "customer", tenantId: TENANT_A };
const OPERATOR: RunScope = { role: "operator" };

function run(runId: string, tenantId?: string): RunSummary {
  return {
    runId,
    repo: "acme/web",
    issue: 1,
    status: "succeeded",
    stage: "done",
    createdAt: "2026-10-05T10:00:00.000Z",
    updatedAt: "2026-10-05T10:00:00.000Z",
    attemptCount: 1,
    reviewCount: 0,
    iterationCount: 0,
    fixCycleCount: 0,
    ...(tenantId === undefined ? {} : { tenantId }),
  } as unknown as RunSummary;
}

/** A read-only stub of the store seam: the scope is the query layer's job. */
function storeWith(runs: RunSummary[]): RunHistoryStore {
  return {
    async listRuns() {
      return { ok: true, value: { items: runs } };
    },
    async getRun(runId: string) {
      return { ok: true, value: runs.find((row) => row.runId === runId) ?? null };
    },
    async listRunEvents() {
      return { ok: true, value: { items: [] } };
    },
    async getRunMetrics() {
      return { ok: true, value: {} as never };
    },
  } as unknown as RunHistoryStore;
}

describe("run visibility scope (#215)", () => {
  it("is fail-closed for a customer with no tenant", () => {
    expect(isRunVisible({ role: "customer" }, run("r-a", TENANT_A))).toBe(false);
    // An unattributed run is never visible to a customer.
    expect(isRunVisible(CUSTOMER_A, run("r-none"))).toBe(false);
  });

  it("lets an operator see every run, including unattributed ones", async () => {
    const store = storeWith([run("r-a", TENANT_A), run("r-b", TENANT_B), run("r-none")]);
    const out = await queryRunListFromParams(store, {}, OPERATOR);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runs.map((row) => row.runId).sort()).toEqual(["r-a", "r-b", "r-none"]);
  });

  it("scopes a customer to their own tenant only", async () => {
    const store = storeWith([run("r-a", TENANT_A), run("r-b", TENANT_B), run("r-none")]);
    const out = await queryRunListFromParams(store, {}, CUSTOMER_A);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runs.map((row) => row.runId)).toEqual(["r-a"]);
  });

  it("hides another tenant's run behind a 404 and serves the customer's own", async () => {
    const store = storeWith([run("r-a", TENANT_A), run("r-b", TENANT_B)]);

    const foreign = await queryRunDetailFromParams(store, "r-b", {}, CUSTOMER_A);
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.status).toBe(404);

    const own = await queryRunDetailFromParams(store, "r-a", {}, CUSTOMER_A);
    expect(own.ok).toBe(true);
  });

  it("refuses unscoped metrics to a customer rather than leaking a global figure", async () => {
    const store = storeWith([]);
    const out = await queryRunMetricsFromParams(store, {}, CUSTOMER_A);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(403);
  });
});