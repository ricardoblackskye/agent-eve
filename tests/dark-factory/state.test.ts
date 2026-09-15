import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toExecutionContext,
  InvalidExecutionContextError,
  ConsoleStateProvider,
  SqliteStateAdapter,
  deliveryKey,
  saveContext,
  loadContext,
} from "../../agent/lib/dark-factory/state";

describe("ExecutionContext canonical shape (#134)", () => {
  it("round-trips the four canonical execution-memory fields", () => {
    const ctx = toExecutionContext({
      issue: 129,
      worker: "W1",
      lastTest: "passed",
      step: "plan",
    });
    expect(ctx).toEqual({
      issue: 129,
      worker: "W1",
      lastTest: "passed",
      step: "plan",
    });
  });

  it("accepts a null lastTest when no test has run yet", () => {
    const ctx = toExecutionContext({
      issue: 129,
      worker: "W1",
      lastTest: null,
      step: "plan",
    });
    expect(ctx.lastTest).toBeNull();
  });

  it("rejects a missing worker, naming the offending field", () => {
    expect(() =>
      toExecutionContext({ issue: 129, lastTest: null, step: "plan" }),
    ).toThrow(InvalidExecutionContextError);
    expect(() =>
      toExecutionContext({ issue: 129, lastTest: null, step: "plan" }),
    ).toThrow(/worker/);
  });

  it("rejects a missing issue number", () => {
    expect(() =>
      toExecutionContext({ worker: "W1", lastTest: null, step: "plan" }),
    ).toThrow(/issue/);
  });

  it("rejects a non-positive issue number", () => {
    expect(() =>
      toExecutionContext({ issue: 0, worker: "W1", lastTest: null, step: "plan" }),
    ).toThrow(/issue/);
  });

  it("rejects a missing loop step", () => {
    expect(() => toExecutionContext({ issue: 129, worker: "W1" })).toThrow(/step/);
  });

  it("drops non-canonical fields so provider noise never reaches the store", () => {
    const ctx = toExecutionContext({
      issue: 129,
      worker: "W1",
      lastTest: null,
      step: "plan",
      ...({ githubIssueId: 999, jiraKey: "DF-1" } as Record<string, unknown>),
    });
    expect(Object.keys(ctx).sort()).toEqual(["issue", "lastTest", "step", "worker"]);
  });
});

const sampleContext = toExecutionContext({
  issue: 134,
  worker: "W1",
  lastTest: null,
  step: "plan",
});

describe("StateStore seam — fail-closed console default (#134)", () => {
  it("reports the console provider id and refuses a write it cannot persist", async () => {
    const store = new ConsoleStateProvider();
    expect(store.id).toBe("console");

    const res = await store.save(deliveryKey(134), sampleContext);

    expect(res.ok).toBe(false);
    expect(res.mode).toBe("blocked");
    expect(res.error).toMatch(/not configured/i);
  });

  it("refuses a read with an explicit error instead of silently yielding nothing", async () => {
    const res = await new ConsoleStateProvider().get(deliveryKey(134));

    expect(res.ok).toBe(false);
    expect(res.mode).toBe("blocked");
    expect(res.value).toBeNull();
    expect(res.error).toMatch(/not configured/i);
  });
});

describe("SqliteStateAdapter — real external state (#134 AC1-AC3)", () => {
  const dirs: string[] = [];
  const makePath = () => {
    const dir = mkdtempSync(join(tmpdir(), "df-state-"));
    dirs.push(dir);
    return join(dir, "state.sqlite");
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it("round-trips an execution context through a real external store (AC1)", async () => {
    const store = new SqliteStateAdapter(makePath());

    const saved = await saveContext(store, sampleContext);
    expect(saved.ok).toBe(true);
    expect(saved.mode).toBe("live");
    expect(saved.providerId).toBe("sqlite");

    const loaded = await loadContext(store, 134);
    expect(loaded.ok).toBe(true);
    expect(loaded.value).toEqual(sampleContext);

    store.close();
  });

  it("returns ok with a null value for an unknown key (not-found is not an outage)", async () => {
    const store = new SqliteStateAdapter(makePath());

    const res = await loadContext(store, 999);
    expect(res.ok).toBe(true);
    expect(res.mode).toBe("live");
    expect(res.value).toBeNull();

    store.close();
  });

  it("persists an overwrite across store instances (AC2)", async () => {
    const path = makePath();
    const first = new SqliteStateAdapter(path);
    await saveContext(first, sampleContext);
    await saveContext(
      first,
      toExecutionContext({
        issue: 134,
        worker: "W2",
        lastTest: "passed",
        step: "implement",
      }),
    );
    first.close();

    const second = new SqliteStateAdapter(path);
    const loaded = await loadContext(second, 134);
    expect(loaded.value).toEqual({
      issue: 134,
      worker: "W2",
      lastTest: "passed",
      step: "implement",
    });
    second.close();
  });

  it("returns an explicit unreachable error instead of failing silently (AC3)", async () => {
    const missing = join(tmpdir(), `df-absent-${Date.now()}`, "nested", "state.sqlite");
    const store = new SqliteStateAdapter(missing);

    const write = await saveContext(store, sampleContext);
    expect(write.ok).toBe(false);
    expect(write.mode).toBe("blocked");
    expect(write.error).toMatch(/unreachable/i);

    const read = await loadContext(store, 134);
    expect(read.ok).toBe(false);
    expect(read.value).toBeNull();
    expect(read.error).toMatch(/unreachable/i);
  });

  it("stays within the 100ms p95 state NFR on a modest loop", async () => {
    const store = new SqliteStateAdapter(makePath());
    const samples: number[] = [];

    for (let i = 0; i < 50; i += 1) {
      const started = performance.now();
      await saveContext(store, { ...sampleContext, step: `step-${i}` });
      await loadContext(store, 134);
      samples.push(performance.now() - started);
    }
    store.close();

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(100);
  });
});