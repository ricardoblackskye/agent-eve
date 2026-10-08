/**
 * #268 — orchestration handler: developer → tester → pr, wired to the Dispatcher.
 *
 * The handler owns SEQUENCE + TRANSLATION; the Dispatcher owns retry/backoff,
 * parking, and per-run status. These tests pin both together: the unit tests
 * assert the sequence and the control-error translation, and the integration
 * tests drive a REAL `Dispatcher` to prove AC2/AC3/AC4 hold through the handler.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  createDispatchHandler,
  type FactoryStages,
} from "../../agent/lib/dark-factory/dispatch-handler";
import {
  Dispatcher,
  ParkedRunError,
  dispatchKey,
  toDispatchEvent,
  type DispatchEvent,
  type DispatchRecord,
} from "../../agent/lib/dark-factory/dispatch";
import { SqliteStateAdapter } from "../../agent/lib/dark-factory/state";

const stores: SqliteStateAdapter[] = [];
const newStore = (): SqliteStateAdapter => {
  const s = new SqliteStateAdapter(":memory:");
  stores.push(s);
  return s;
};
afterEach(() => {
  while (stores.length) stores.pop()?.close?.();
});

const event = (runId = "run-268"): DispatchEvent =>
  toDispatchEvent({
    runId,
    repo: "ricardoblackskye/agent-eve",
    ref: "main",
    status: "success",
  });

/** Stages that record their names in order; overrides let a test bend one stage. */
function recordingStages(overrides: Partial<FactoryStages> = {}) {
  const order: string[] = [];
  const stages: FactoryStages = {
    developer: async () => {
      order.push("developer");
    },
    tester: async () => {
      order.push("tester");
      return { passed: true };
    },
    pr: async () => {
      order.push("pr");
    },
    ...overrides,
  };
  return { order, stages };
}

describe("#268 orchestration handler — sequence", () => {
  it("runs developer → tester → pr in order", async () => {
    const { order, stages } = recordingStages();
    await createDispatchHandler({ stages })(event(), "developer", async () => {});
    expect(order).toEqual(["developer", "tester", "pr"]);
  });

  it("checkpoints before each stage", async () => {
    let checks = 0;
    const atStageEntry: number[] = [];
    const stages: FactoryStages = {
      developer: async () => {
        atStageEntry.push(checks);
      },
      tester: async () => {
        atStageEntry.push(checks);
        return { passed: true };
      },
      pr: async () => {
        atStageEntry.push(checks);
      },
    };
    await createDispatchHandler({ stages })(event(), "developer", async () => {
      checks += 1;
    });
    expect(atStageEntry).toEqual([1, 2, 3]);
  });

  it("propagates a checkpoint control error and skips later stages", async () => {
    const { order, stages } = recordingStages();
    let calls = 0;
    const checkpoint = async () => {
      calls += 1;
      if (calls >= 2) throw new Error("run stopped");
    };
    await expect(
      createDispatchHandler({ stages })(event(), "developer", checkpoint),
    ).rejects.toThrow("run stopped");
    // checkpoint fires before developer (ok) then before tester (throws),
    // so developer ran and tester/pr never started.
    expect(order).toEqual(["developer"]);
  });
});

describe("#268 orchestration handler — tester gate", () => {
  it("runs the pr stage only when the gate passes", async () => {
    const { order, stages } = recordingStages();
    await createDispatchHandler({ stages })(event(), "developer", async () => {});
    expect(order).toContain("pr");
  });

  it("throws a retryable error and skips pr when the gate fails", async () => {
    const order: string[] = [];
    const stages: FactoryStages = {
      developer: async () => {
        order.push("developer");
      },
      tester: async () => {
        order.push("tester");
        return { passed: false, reason: "2 tests failed" };
      },
      pr: async () => {
        order.push("pr");
      },
    };
    await expect(
      createDispatchHandler({ stages })(event(), "developer", async () => {}),
    ).rejects.toThrow(/Tester gate failed.*2 tests failed/);
    expect(order).toEqual(["developer", "tester"]);
  });

  it("throws ParkedRunError when the tester parks the run", async () => {
    const stages: FactoryStages = {
      developer: async () => {},
      tester: async () => ({ passed: false, parked: true, reason: "which branch?" }),
      pr: async () => {},
    };
    await expect(
      createDispatchHandler({ stages })(event(), "developer", async () => {}),
    ).rejects.toBeInstanceOf(ParkedRunError);
  });
});

describe("#268 orchestration handler — Dispatcher integration", () => {
  it("AC2: retries a failing gate via the Dispatcher, then succeeds", async () => {
    const store = newStore();
    let developerRuns = 0;
    let testerRuns = 0;
    let sleeps = 0;
    const stages: FactoryStages = {
      developer: async () => {
        developerRuns += 1;
      },
      tester: async () => {
        testerRuns += 1;
        return { passed: testerRuns >= 3, reason: "flaky gate" };
      },
      pr: async () => {},
    };
    const dispatcher = new Dispatcher({
      store,
      handler: createDispatchHandler({ stages }),
      // default policy: maxRetries 2 -> up to 3 attempts
      sleep: async () => {
        sleeps += 1;
      },
    });

    const outcome = await dispatcher.dispatch(event("run-ac2"));

    expect(outcome.status).toBe("succeeded");
    expect(developerRuns).toBe(3);
    expect(sleeps).toBe(2);
  });

  it("AC3: parks a run without consuming retry budget or sleeping", async () => {
    const store = newStore();
    let developerRuns = 0;
    let sleeps = 0;
    const stages: FactoryStages = {
      developer: async () => {
        developerRuns += 1;
      },
      tester: async () => ({ passed: false, parked: true, reason: "which branch?" }),
      pr: async () => {},
    };
    const dispatcher = new Dispatcher({
      store,
      handler: createDispatchHandler({ stages }),
      sleep: async () => {
        sleeps += 1;
      },
    });

    const outcome = await dispatcher.dispatch(event("run-ac3"));

    expect(outcome.status).toBe("blocked");
    expect(developerRuns).toBe(1);
    expect(sleeps).toBe(0);
  });

  it("AC4: records dispatch status per run", async () => {
    const store = newStore();
    const { stages } = recordingStages();
    const dispatcher = new Dispatcher({
      store,
      handler: createDispatchHandler({ stages }),
      sleep: async () => {},
    });

    await dispatcher.dispatch(event("run-ac4"));

    const record = await store.get<DispatchRecord>(dispatchKey("run-ac4"));
    expect(record.value?.status).toBe("succeeded");
    expect(record.value?.attempts).toBe(1);
  });

  it("propagates a developer-stage failure as a bounded terminal failure", async () => {
    const store = newStore();
    let developerRuns = 0;
    const stages: FactoryStages = {
      developer: async () => {
        developerRuns += 1;
        throw new Error("developer exploded");
      },
      tester: async () => ({ passed: true }),
      pr: async () => {},
    };
    const dispatcher = new Dispatcher({
      store,
      handler: createDispatchHandler({ stages }),
      sleep: async () => {},
    });

    const outcome = await dispatcher.dispatch(event("run-dev-fail"));

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("failed");
    expect(developerRuns).toBe(3); // 1 attempt + 2 retries (DEFAULT_RETRY_POLICY)
  });
});
