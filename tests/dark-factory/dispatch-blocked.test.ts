/**
 * #162 (decision A) — `blocked` is a first-class dispatch state.
 *
 * A run parked on a human question is NOT retrying: the ACs forbid it consuming
 * further iterations or worker-minutes. Modelling it as a real status means the
 * dispatch record tells the truth, and anything reading dispatch state (metrics,
 * the operator, #163's trigger) can tell "waiting on a human" from "retrying"
 * without a second lookup.
 */
import { describe, it, expect } from "vitest";
import {
  Dispatcher,
  ParkedRunError,
  dispatchKey,
  toDispatchEvent,
  type DispatchEvent,
  type DispatchRecord,
} from "../../agent/lib/dark-factory/dispatch";
import type {
  StateReadResult,
  StateStore,
  StateWriteResult,
} from "../../agent/lib/dark-factory/state";

class MemoryStore implements StateStore {
  id = "memory";
  private readonly data = new Map<string, unknown>();
  async save(key: string, value: unknown): Promise<StateWriteResult> {
    this.data.set(key, value);
    return { ok: true, mode: "live", providerId: this.id };
  }
  async get<T = unknown>(key: string): Promise<StateReadResult<T>> {
    return {
      ok: true,
      mode: "live",
      providerId: this.id,
      value: (this.data.get(key) ?? null) as T | null,
    };
  }
}

const event = (): DispatchEvent =>
  toDispatchEvent({ runId: "run-162", repo: "ricardoblackskye/agent-eve", ref: "main", status: "success" });

const recordOf = async (store: StateStore, runId: string): Promise<DispatchRecord | null> => {
  const read = await store.get<DispatchRecord>(dispatchKey(runId));
  return read.value;
};

describe("#162 cycle 11: a question parks the run in a real state", () => {
  it("records `blocked`, reports it, and tells the observer the truth", async () => {
    const store = new MemoryStore();
    const seen: string[] = [];
    const dispatcher = new Dispatcher({
      store,
      handler: async () => {
        throw new ParkedRunError("waiting on a human answer to: which branch?");
      },
      observer: (m) => {
        seen.push(m.status);
      },
      sleep: async () => {},
    });

    const outcome = await dispatcher.dispatch(event());

    expect(outcome.status).toBe("blocked");
    expect((await recordOf(store, "run-162"))?.status).toBe("blocked");
    expect(seen).toContain("blocked");
  });
});

describe("#162 cycle 12: a parked run consumes nothing", () => {
  it("does not retry and does not sleep between attempts", async () => {
    const store = new MemoryStore();
    let calls = 0;
    let sleeps = 0;
    const dispatcher = new Dispatcher({
      store,
      handler: async () => {
        calls += 1;
        throw new ParkedRunError("blocked on a human decision");
      },
      sleep: async () => {
        sleeps += 1;
      },
    });

    const outcome = await dispatcher.dispatch(event());

    expect(calls).toBe(1); // no further iterations
    expect(sleeps).toBe(0); // and no backoff burn while a human reads
    expect(outcome.attempts).toBe(1);
  });

  it("still retries an ORDINARY failure — parking must not swallow real errors", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const dispatcher = new Dispatcher({
      store,
      handler: async () => {
        calls += 1;
        throw new Error("genuine failure");
      },
      policy: { maxRetries: 2, baseDelayMs: 1, backoffMultiplier: 1 },
      sleep: async () => {},
    });

    const outcome = await dispatcher.dispatch(event());

    expect(calls).toBe(3); // 1 + 2 retries
    expect(outcome.status).toBe("failed");
  });
});

describe("#162 cycle 13: a human reply resumes the run — and only that", () => {
  it("re-runs the handler on an EXPLICIT resume and clears the blocked state", async () => {
    const store = new MemoryStore();
    let parked = true;
    let calls = 0;
    const dispatcher = new Dispatcher({
      store,
      handler: async () => {
        calls += 1;
        if (parked) throw new ParkedRunError("blocked on a human decision");
      },
      sleep: async () => {},
    });

    const first = await dispatcher.dispatch(event());
    expect(first.status).toBe("blocked");
    expect(calls).toBe(1);

    // A plain RE-DELIVERY while parked is HELD, not resumed: webhook deliveries
    // are at-least-once, and resuming on one would consume the wait the park
    // exists to protect.
    const held = await dispatcher.dispatch(event());
    expect(held.status).toBe("blocked");
    expect(held.duplicate).toBe(true);
    expect(calls).toBe(1);

    parked = false; // the human replied and the label was cleared
    const resumed = await dispatcher.dispatch(event(), { resume: true });

    expect(resumed.status).toBe("succeeded");
    expect(calls).toBe(2);
    expect((await recordOf(store, "run-162"))?.status).toBe("succeeded");
  });
});
