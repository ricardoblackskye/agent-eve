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

/** The strict, steady-state per-operation ceiling the state NFR describes. */
export const NFR_P95_MS = 100;
/**
 * The ceiling used on a shared CI runner (#167).
 *
 * 15x the NFR: enough that contention cannot fail it, while a real regression —
 * the failure that surfaced the flake was a 10s p95 — still trips it.
 */
export const CI_NFR_P95_MS = 1500;

/**
 * Choose the p95 ceiling for the NFR assertion (#167).
 *
 * Why this exists rather than one constant: the NFR is a WALL-CLOCK,
 * steady-state per-operation latency budget, and a shared CI runner cannot honour
 * 100ms under contention — this assertion measured 561ms on CI (and ~170ms
 * before the warm-up pass existed) while the adapter itself was healthy. A gate
 * that fails for reasons unrelated to the change teaches people to re-run it
 * rather than read it, which is worse than no gate at all. So the budget is
 * stated per environment instead: strict where the number is meaningful,
 * generous where it cannot be, and well below a genuine regression.
 *
 * Precedence: an explicit DF_STATE_NFR_P95_MS wins (a self-hosted runner can be
 * tuned without editing code), then the CI budget, then the NFR itself. A
 * nonsense override is IGNORED, never honoured: `0` would assert `p95 < 0` and
 * `NaN` would make every comparison false — either way a silently disabled gate
 * that still reports green.
 */
export function resolveP95Ceiling(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = (env.DF_STATE_NFR_P95_MS ?? "").trim();
  const explicit = raw === "" ? Number.NaN : Number(raw);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const ci = (env.CI ?? "").trim().toLowerCase();
  return ci === "true" || ci === "1" ? CI_NFR_P95_MS : NFR_P95_MS;
}

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

  it("stays within the state p95 NFR on a modest loop (100ms local, CI budget on a shared runner)", async () => {
    const store = new SqliteStateAdapter(makePath());

    // Warm up first. The initial operations pay cold-start costs (opening the
    // database, creating schema/prepared statements); including them made this
    // NFR assertion flaky on shared CI runners (observed p95 ~170ms while the
    // steady-state cost is an order of magnitude lower). The NFR describes
    // steady-state per-operation latency, so those samples are discarded.
    const WARMUP = 10;
    for (let i = 0; i < WARMUP; i += 1) {
      await saveContext(store, { ...sampleContext, step: `warmup-${i}` });
      await loadContext(store, 134);
    }

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
    // The ceiling is environment-aware (#167): 100ms is the NFR and applies
    // wherever the number is meaningful, while a shared CI runner gets a budget
    // it can honour. See `resolveP95Ceiling` below for the reasoning, and for how
    // an explicit DF_STATE_NFR_P95_MS still wins over both.
    const ceiling = resolveP95Ceiling();
    expect(
      p95,
      `p95 ${p95.toFixed(1)}ms over a ${ceiling}ms ceiling (NFR ${NFR_P95_MS}ms)`,
    ).toBeLessThan(ceiling);
  });
});

/**
 * #167 — the p95 ceiling is environment-aware rather than flaky.
 *
 * A flaky gate teaches people to re-run it instead of reading it, which is the
 * opposite of what a safety check is for. These cases pin the precedence and,
 * importantly, the refusal to honour a nonsense override.
 */
describe("#167 — p95 ceiling resolution", () => {
  it("enforces the strict NFR wherever the number is meaningful", () => {
    expect(resolveP95Ceiling({})).toBe(100);
    expect(resolveP95Ceiling({ CI: "false" })).toBe(100);
  });

  it("raises the ceiling on a shared runner instead of flaking", () => {
    expect(resolveP95Ceiling({ CI: "true" })).toBe(1500);
    expect(resolveP95Ceiling({ CI: "1" })).toBe(1500);
  });

  it("lets an explicit override win, so a self-hosted runner can be tuned", () => {
    expect(resolveP95Ceiling({ CI: "true", DF_STATE_NFR_P95_MS: "2500" })).toBe(2500);
    expect(resolveP95Ceiling({ DF_STATE_NFR_P95_MS: "150" })).toBe(150);
  });

  it("ignores a nonsense override rather than silently disabling the gate", () => {
    // Number("") is 0 and Number("abc") is NaN. Honouring either would make the
    // assertion `p95 < 0` (always false) or compare against NaN (also always
    // false) — a disabled gate that still reports as passing.
    expect(resolveP95Ceiling({ DF_STATE_NFR_P95_MS: "" })).toBe(100);
    expect(resolveP95Ceiling({ DF_STATE_NFR_P95_MS: "abc", CI: "true" })).toBe(1500);
    expect(resolveP95Ceiling({ DF_STATE_NFR_P95_MS: "-5" })).toBe(100);
    expect(resolveP95Ceiling({ DF_STATE_NFR_P95_MS: "0" })).toBe(100);
  });
});