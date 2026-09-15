import { describe, it, expect } from "vitest";
import {
  countFixCycles,
  InMemoryMetricsStore,
  InvalidMetricsError,
  BufferedMetricsRecorder,
  createMetricsStore,
  type MetricsStore,
  type TaskStatus,
} from "../../agent/lib/dark-factory/metrics";

describe("countFixCycles exactness (#140 AC2)", () => {
  it("counts a single fail -> fix cycle", () => {
    expect(countFixCycles(["test-fail", "test-fix"])).toBe(1);
  });

  it("pairs two fails with two fixes", () => {
    expect(countFixCycles(["test-fail", "test-fail", "test-fix", "test-fix"])).toBe(2);
  });

  it("does not count a fail that was never fixed", () => {
    expect(countFixCycles(["test-fail"])).toBe(0);
    expect(countFixCycles(["test-fail", "test-fix", "test-fail"])).toBe(1);
  });

  it("does not count a fix with no preceding fail", () => {
    expect(countFixCycles(["test-fix"])).toBe(0);
    expect(countFixCycles([])).toBe(0);
  });

  it("ignores an unmatched extra fix", () => {
    expect(countFixCycles(["test-fail", "test-fix", "test-fix"])).toBe(1);
  });
});

describe("InMemoryMetricsStore ingestion (#140 AC1/AC4)", () => {
  it("persists a completed task's metric record", async () => {
    const store = new InMemoryMetricsStore();

    const res = await store.record("code-fix", {
      iterations: 3,
      fixCycles: 2,
      status: "success",
    });

    expect(res.ok).toBe(true);
    expect(res.mode).toBe("live");
    expect(res.record).toEqual({
      taskType: "code-fix",
      iterations: 3,
      fixCycles: 2,
      status: "success",
    });
    expect(store.getRecords()).toHaveLength(1);
  });

  it("keeps records from every emitting component without an interface change", async () => {
    const store = new InMemoryMetricsStore();

    await store.record("code-fix", { iterations: 1, fixCycles: 0, status: "success" });
    await store.record("code-review", { iterations: 2, fixCycles: 1, status: "failure" });
    await store.record("e2e", { iterations: 4, fixCycles: 3, status: "success" });

    expect(store.getRecords().map((r) => r.taskType)).toEqual([
      "code-fix",
      "code-review",
      "e2e",
    ]);
  });

  it("rejects an empty task type", async () => {
    const store = new InMemoryMetricsStore();
    await expect(
      store.record("  ", { iterations: 1, fixCycles: 0, status: "success" }),
    ).rejects.toThrow(InvalidMetricsError);
  });

  it("rejects a negative or fractional iteration count", async () => {
    const store = new InMemoryMetricsStore();
    await expect(
      store.record("code-fix", { iterations: -1, fixCycles: 0, status: "success" }),
    ).rejects.toThrow(/iterations/);
    await expect(
      store.record("code-fix", { iterations: 1.5, fixCycles: 0, status: "success" }),
    ).rejects.toThrow(/iterations/);
  });

  it("rejects a negative fix-cycle count and an unknown status", async () => {
    const store = new InMemoryMetricsStore();
    await expect(
      store.record("code-fix", { iterations: 1, fixCycles: -2, status: "success" }),
    ).rejects.toThrow(/fixCycles/);
    await expect(
      store.record("code-fix", {
        iterations: 1,
        fixCycles: 0,
        status: "broken" as unknown as "success",
      }),
    ).rejects.toThrow(/status/);
  });
});

describe("success rate per task type (#140 AC3)", () => {
  const fill = async (store: InMemoryMetricsStore, successes: number, failures: number) => {
    for (let i = 0; i < successes; i += 1) {
      await store.record("code-fix", { iterations: 1, fixCycles: 0, status: "success" });
    }
    for (let i = 0; i < failures; i += 1) {
      await store.record("code-fix", { iterations: 1, fixCycles: 0, status: "failure" });
    }
  };

  it("returns K/N rounded to two decimals", async () => {
    const store = new InMemoryMetricsStore();
    await fill(store, 7, 3);
    expect(store.successRateByType("code-fix")).toBeCloseTo(0.7, 2);
  });

  it("rounds a repeating decimal to two places", async () => {
    const store = new InMemoryMetricsStore();
    await fill(store, 1, 2);
    expect(store.successRateByType("code-fix")).toBeCloseTo(0.33, 2);
  });

  it("keeps task types independent and reports null for an unknown type", async () => {
    const store = new InMemoryMetricsStore();
    await fill(store, 1, 1);
    await store.record("e2e", { iterations: 1, fixCycles: 0, status: "success" });

    expect(store.successRateByType("code-fix")).toBeCloseTo(0.5, 2);
    expect(store.successRateByType("e2e")).toBeCloseTo(1, 2);
    expect(store.successRateByType("ghost")).toBeNull();
  });
});

/** Store whose backend is down until `healthy` is flipped. */
class FlakyStore implements MetricsStore {
  id = "flaky";
  healthy = false;
  private readonly inner = new InMemoryMetricsStore();

  async record(
    taskType: string,
    data: { iterations: number; fixCycles: number; status: TaskStatus },
  ) {
    if (!this.healthy) {
      return {
        ok: false,
        mode: "blocked" as const,
        providerId: this.id,
        error: "metrics backend unreachable",
      };
    }
    return this.inner.record(taskType, data);
  }

  successRateByType(type: string) {
    return this.inner.successRateByType(type);
  }

  getRecords() {
    return this.inner.getRecords();
  }
}

describe("no-loss guarantee (#140 MUST NOT lose records)", () => {
  it("surfaces a persistence failure instead of reporting a stored record", async () => {
    const recorder = new BufferedMetricsRecorder(new FlakyStore());

    const res = await recorder.record("code-fix", {
      iterations: 2,
      fixCycles: 1,
      status: "success",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/buffered/i);
  });

  it("retains the record for retry and flushes it once the backend recovers", async () => {
    const backend = new FlakyStore();
    const recorder = new BufferedMetricsRecorder(backend);
    await recorder.record("code-fix", { iterations: 2, fixCycles: 1, status: "success" });
    expect(recorder.pending()).toHaveLength(1);

    backend.healthy = true;
    const flush = await recorder.flush();

    expect(flush.ok).toBe(true);
    expect(recorder.pending()).toHaveLength(0);
    expect(backend.getRecords()).toHaveLength(1);
    expect(backend.successRateByType("code-fix")).toBeCloseTo(1, 2);
  });

  it("passes a healthy write straight through without buffering", async () => {
    const backend = new FlakyStore();
    backend.healthy = true;
    const recorder = new BufferedMetricsRecorder(backend);

    const res = await recorder.record("e2e", { iterations: 1, fixCycles: 0, status: "failure" });

    expect(res.ok).toBe(true);
    expect(recorder.pending()).toHaveLength(0);
    expect(backend.getRecords()).toHaveLength(1);
  });
});

describe("createMetricsStore env wiring (#140)", () => {
  it("defaults to the in-memory store", () => {
    expect(createMetricsStore({}).id).toBe("memory");
  });

  it("accepts an explicit memory driver", () => {
    expect(createMetricsStore({ DF_METRICS_DRIVER: "memory" }).id).toBe("memory");
  });

  it("refuses an unknown driver instead of silently degrading", () => {
    expect(() => createMetricsStore({ DF_METRICS_DRIVER: "redis" })).toThrow(/redis/);
  });
});