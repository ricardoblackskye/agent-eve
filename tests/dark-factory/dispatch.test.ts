import { describe, it, expect } from "vitest";
import { SqliteStateAdapter } from "../../agent/lib/dark-factory/state";
import {
  toDispatchEvent,
  InvalidDispatchEventError,
  dedupKey,
  dispatchKey,
  nextRetry,
  Dispatcher,
  type DispatchRecord,
  type DispatchAttemptMetric,
} from "../../agent/lib/dark-factory/dispatch";
import type { StateReadResult, StateStore, StateWriteResult } from "../../agent/lib/dark-factory/state";

/** Store whose backend THROWS instead of returning a structured error. */
class ThrowingStore implements StateStore {
  id = "throwing";
  private readonly mode: "read" | "write";

  constructor(mode: "read" | "write") {
    this.mode = mode;
  }

  async get<T = unknown>(): Promise<StateReadResult<T>> {
    if (this.mode === "read") throw new Error("redis exploded");
    return { ok: true, mode: "dry-run", providerId: this.id, value: null };
  }

  async save(): Promise<StateWriteResult> {
    if (this.mode === "write") throw new Error("disk on fire");
    return { ok: true, mode: "live", providerId: this.id };
  }
}

const failure = { runId: "abc123", repo: "o/r", ref: "main", status: "failure" as const };

describe("canonical CI-event payload (#138 AC1)", () => {
  it("normalises a CI failure into a canonical event", () => {
    expect(toDispatchEvent(failure)).toEqual({
      runId: "abc123",
      repo: "o/r",
      ref: "main",
      status: "failure",
    });
  });

  it("rejects an event without a run id, naming the field", () => {
    expect(() =>
      toDispatchEvent({ repo: "o/r", ref: "main", status: "failure" }),
    ).toThrow(InvalidDispatchEventError);
    expect(() =>
      toDispatchEvent({ repo: "o/r", ref: "main", status: "failure" }),
    ).toThrow(/runId/);
  });

  it("derives a stable dedup key from the run id alone", () => {
    const sameRunOtherRef = toDispatchEvent({
      runId: "abc123",
      repo: "o/r",
      ref: "release",
      status: "failure",
    });
    expect(dedupKey(toDispatchEvent(failure))).toBe(dedupKey(sameRunOtherRef));
    expect(dedupKey(toDispatchEvent(failure))).not.toBe(
      dedupKey(toDispatchEvent({ ...failure, runId: "def456" })),
    );
  });
});

describe("idempotent dispatch lifecycle (#138 AC2)", () => {
  it("executes the worker handler exactly once for a re-delivered event", async () => {
    const store = new SqliteStateAdapter(":memory:");
    let handled = 0;
    const dispatcher = new Dispatcher({
      store,
      handler: async () => {
        handled += 1;
      },
      sleep: async () => {},
    });
    const event = toDispatchEvent(failure);

    const first = await dispatcher.dispatch(event);
    expect(first.ok).toBe(true);
    expect(first.status).toBe("succeeded");

    const second = await dispatcher.dispatch(event);
    expect(second.duplicate).toBe(true);
    expect(handled).toBe(1);

    store.close?.();
  });
});

const policy = { maxRetries: 2, baseDelayMs: 100, backoffMultiplier: 3 };

describe("bounded retry policy (#138 AC3/AC4)", () => {
  it("schedules the next attempt with exponential backoff", () => {
    expect(nextRetry(policy, 1)).toEqual({ attempt: 2, delayMs: 100 });
    expect(nextRetry(policy, 2)).toEqual({ attempt: 3, delayMs: 300 });
  });

  it("returns null once the retry budget is exhausted", () => {
    expect(nextRetry(policy, 3)).toBeNull();
    expect(nextRetry(policy, 4)).toBeNull();
  });

  it("retries a failing dispatch per the policy, then terminates as failed", async () => {
    const store = new SqliteStateAdapter(":memory:");
    const delays: number[] = [];
    const metrics: DispatchAttemptMetric[] = [];
    let attempts = 0;
    const dispatcher = new Dispatcher({
      store,
      policy,
      handler: async () => {
        attempts += 1;
        throw new Error("CI runner unavailable");
      },
      observer: (m) => {
        metrics.push(m);
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await dispatcher.dispatch(toDispatchEvent(failure));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(3);
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 300]);

    const persisted = await store.get<DispatchRecord>(dispatchKey("abc123"));
    expect(persisted.value?.status).toBe("failed");
    expect(persisted.value?.attempts).toBe(3);
    expect(persisted.value?.error).toMatch(/CI runner unavailable/);

    store.close?.();
  });

  it("walks dispatched -> retrying -> dispatched -> succeeded when a retry recovers", async () => {
    const store = new SqliteStateAdapter(":memory:");
    const delays: number[] = [];
    const metrics: DispatchAttemptMetric[] = [];
    let attempts = 0;
    const dispatcher = new Dispatcher({
      store,
      policy,
      handler: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("flaky runner");
      },
      observer: (m) => {
        metrics.push(m);
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await dispatcher.dispatch(toDispatchEvent(failure));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("succeeded");
    expect(result.attempts).toBe(2);
    expect(delays).toEqual([100]);
    expect(metrics.map((m) => m.status)).toEqual([
      "dispatched",
      "retrying",
      "dispatched",
      "succeeded",
    ]);

    const persisted = await store.get<DispatchRecord>(dispatchKey("abc123"));
    expect(persisted.value?.status).toBe("succeeded");
    expect(persisted.value?.attempts).toBe(2);

    store.close?.();
  });
});

describe("dispatch lifecycle + routing (#138 AC1)", () => {
  it("routes a CI failure to the developer worker and persists the terminal record", async () => {
    const store = new SqliteStateAdapter(":memory:");
    const seen: string[] = [];
    const dispatcher = new Dispatcher({
      store,
      handler: async (_event, worker) => {
        seen.push(worker);
      },
      sleep: async () => {},
    });

    const result = await dispatcher.dispatch(toDispatchEvent(failure));

    expect(seen).toEqual(["developer"]);
    expect(result.worker).toBe("developer");
    const persisted = await store.get<DispatchRecord>(dispatchKey("abc123"));
    expect(persisted.value?.status).toBe("succeeded");
    expect(persisted.value?.attempts).toBe(1);

    store.close?.();
  });

  it("honours an injected router", async () => {
    const store = new SqliteStateAdapter(":memory:");
    const seen: string[] = [];
    const dispatcher = new Dispatcher({
      store,
      route: (event) => (event.ref === "main" ? "developer" : "tester"),
      handler: async (_event, worker) => {
        seen.push(worker);
      },
      sleep: async () => {},
    });

    await dispatcher.dispatch(toDispatchEvent({ ...failure, ref: "release" }));

    expect(seen).toEqual(["tester"]);
    store.close?.();
  });

  it("survives a restart: a fresh dispatcher still deduplicates a processed run", async () => {
    const store = new SqliteStateAdapter(":memory:");
    let handled = 0;
    const handler = async () => {
      handled += 1;
    };
    await new Dispatcher({ store, handler, sleep: async () => {} }).dispatch(
      toDispatchEvent(failure),
    );

    const restarted = new Dispatcher({ store, handler, sleep: async () => {} });
    const again = await restarted.dispatch(toDispatchEvent(failure));

    expect(again.duplicate).toBe(true);
    expect(handled).toBe(1);

    store.close?.();
  });

  it("reports a store outage as an explicit error instead of dispatching blindly", async () => {
    const dispatcher = new Dispatcher({
      store: { id: "broken", save: async () => ({ ok: false, mode: "blocked", providerId: "broken", error: "State store unreachable" }), get: async () => ({ ok: false, mode: "blocked", providerId: "broken", value: null, error: "State store unreachable" }) },
      handler: async () => {},
      sleep: async () => {},
    });

    const result = await dispatcher.dispatch(toDispatchEvent(failure));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/unreachable/i);
  });
});

describe("reviewer follow-ups on dispatch (#138)", () => {
  const ev = { runId: "rev-1", repo: "o/r", ref: "main", status: "failure" as const };
  const noRetry = { maxRetries: 0, baseDelayMs: 1, backoffMultiplier: 2 };

  it("reports a duplicate of a FAILED run as accepted-not-actioned, not as a fresh error", async () => {
    const state = new SqliteStateAdapter(":memory:");
    const first = await new Dispatcher({
      store: state,
      policy: noRetry,
      handler: async () => {
        throw new Error("runner down");
      },
      sleep: async () => {},
    }).dispatch(toDispatchEvent(ev));
    expect(first.ok).toBe(false);

    let replayed = 0;
    const dupe = await new Dispatcher({
      store: state,
      policy: noRetry,
      handler: async () => {
        replayed += 1;
      },
      sleep: async () => {},
    }).dispatch(toDispatchEvent(ev));

    expect(dupe.duplicate).toBe(true);
    expect(dupe.status).toBe("failed");
    expect(dupe.ok).toBe(true);
    expect(replayed).toBe(0);

    state.close?.();
  });

  it("bounds a hung handler with a deadline instead of holding the loop forever", async () => {
    const state = new SqliteStateAdapter(":memory:");
    const dispatcher = new Dispatcher({
      store: state,
      policy: noRetry,
      handler: () => new Promise<void>(() => {}),
      handlerTimeoutMs: 25,
      sleep: async () => {},
    });

    const started = Date.now();
    const result = await dispatcher.dispatch(toDispatchEvent(ev));

    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/deadline/i);

    state.close?.();
  }, 5000);

  it("converts a throwing store READ into the structured error shape", async () => {
    const dispatcher = new Dispatcher({
      store: new ThrowingStore("read"),
      handler: async () => {},
      sleep: async () => {},
    });

    const result = await dispatcher.dispatch(toDispatchEvent(ev));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/redis exploded/);
  });

  it("converts a throwing store WRITE into the structured error shape", async () => {
    const dispatcher = new Dispatcher({
      store: new ThrowingStore("write"),
      handler: async () => {},
      sleep: async () => {},
    });

    const result = await dispatcher.dispatch(toDispatchEvent(ev));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disk on fire/);
  });
});