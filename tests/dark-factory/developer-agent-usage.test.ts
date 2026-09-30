import { describe, expect, it } from "vitest";
import { createDeveloperAgent } from "../../agent/lib/dark-factory/developer-agent";
import { InMemoryMetricsStore } from "../../agent/lib/dark-factory/metrics";
import { InMemoryUsageStore } from "../../agent/lib/dark-factory/usage-store";
import { WorkerUsageRecorder } from "../../agent/lib/dark-factory/worker-usage";

describe("DeveloperAgent usage recording (#209)", () => {
  it("appends a usage event when a task completes", async () => {
    const store = new InMemoryUsageStore();
    const agent = createDeveloperAgent({
      metrics: new InMemoryMetricsStore(),
      usage: new WorkerUsageRecorder(store, { runId: "run-1", model: "m" }),
    });

    await agent.recordIteration({
      taskId: "t1",
      iterations: 2,
      fixCycles: 1,
      status: "success",
    });

    const events = store.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      runId: "run-1",
      taskType: "developer",
      model: "m",
    });
  });

  it("records nothing when no usage sink is configured", async () => {
    const store = new InMemoryUsageStore();
    const agent = createDeveloperAgent({ metrics: new InMemoryMetricsStore() });

    await agent.recordIteration({
      taskId: "t1",
      iterations: 1,
      fixCycles: 0,
      status: "success",
    });

    expect(store.getEvents()).toHaveLength(0);
  });

  it("still records the metric when the usage sink throws", async () => {
    const metrics = new InMemoryMetricsStore();
    const agent = createDeveloperAgent({
      metrics,
      usage: {
        record: async () => {
          throw new Error("ledger down");
        },
      },
    });

    await expect(
      agent.recordIteration({
        taskId: "t1",
        iterations: 1,
        fixCycles: 0,
        status: "success",
      }),
    ).resolves.toBeUndefined();

    expect(metrics.getRecords()).toHaveLength(1);
  });

  it("still rejects an invalid record even with a usage sink attached", async () => {
    const store = new InMemoryUsageStore();
    const agent = createDeveloperAgent({
      metrics: new InMemoryMetricsStore(),
      usage: new WorkerUsageRecorder(store, { runId: "run-1", model: "m" }),
    });

    await expect(
      agent.recordIteration({
        taskId: "t1",
        iterations: -1,
        fixCycles: 0,
        status: "success",
      }),
    ).rejects.toThrow();

    expect(store.getEvents()).toHaveLength(0);
  });
});