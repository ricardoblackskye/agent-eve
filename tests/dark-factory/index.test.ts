import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateStore, createRetryPolicy, createDispatchObserver } from "../../agent/lib/dark-factory/index";
import { toExecutionContext, saveContext, loadContext, SqliteStateAdapter } from "../../agent/lib/dark-factory/state";
import { DEFAULT_RETRY_POLICY, Dispatcher, toDispatchEvent } from "../../agent/lib/dark-factory/dispatch";
import { InMemoryMetricsStore } from "../../agent/lib/dark-factory/metrics";

const ctx = toExecutionContext({
  issue: 134,
  worker: "W1",
  lastTest: null,
  step: "plan",
});

describe("createStateStore env wiring (#134)", () => {
  const dirs: string[] = [];
  const makePath = () => {
    const dir = mkdtempSync(join(tmpdir(), "df-wire-"));
    dirs.push(dir);
    return join(dir, "state.sqlite");
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it("returns the sqlite adapter when DF_STATE_DRIVER=sqlite", async () => {
    const path = makePath();
    const store = createStateStore({ DF_STATE_DRIVER: "sqlite", DF_STATE_DB_PATH: path });

    expect(store.id).toBe("sqlite");
    expect((await saveContext(store, ctx)).mode).toBe("live");
    expect((await loadContext(store, 134)).value).toEqual(ctx);

    // Release the file handle before the temp dir is removed (Windows locks it).
    store.close?.();
  });

  it("is fail-closed when DF_STATE_DRIVER is unset", async () => {
    const store = createStateStore({});

    expect(store.id).toBe("console");
    const res = await saveContext(store, ctx);
    expect(res.ok).toBe(false);
    expect(res.mode).toBe("blocked");
    expect(res.error).toMatch(/not configured/i);
  });

  it("refuses an unknown driver instead of silently degrading", () => {
    expect(() => createStateStore({ DF_STATE_DRIVER: "redis" })).toThrow(/redis/);
  });

  it("requires a database path for the sqlite driver", () => {
    expect(() => createStateStore({ DF_STATE_DRIVER: "sqlite" })).toThrow(/DF_STATE_DB_PATH/);
  });
});

describe("createRetryPolicy env wiring (#138)", () => {
  it("defaults to the shipped retry policy", () => {
    expect(createRetryPolicy({})).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("reads the retry limit and base delay from the environment", () => {
    expect(
      createRetryPolicy({ DF_DISPATCH_MAX_RETRIES: "5", DF_DISPATCH_BASE_DELAY_MS: "50" }),
    ).toEqual({ maxRetries: 5, baseDelayMs: 50, backoffMultiplier: 3 });
  });

  it("rejects a non-numeric retry limit instead of silently ignoring it", () => {
    expect(() => createRetryPolicy({ DF_DISPATCH_MAX_RETRIES: "many" })).toThrow(
      /DF_DISPATCH_MAX_RETRIES/,
    );
  });

  it("rejects a negative base delay", () => {
    expect(() => createRetryPolicy({ DF_DISPATCH_BASE_DELAY_MS: "-5" })).toThrow(
      /DF_DISPATCH_BASE_DELAY_MS/,
    );
  });
});

describe("dispatch -> metrics wiring (#140 AC4)", () => {
  const ciEvent = { runId: "run-1", repo: "o/r", ref: "main", status: "failure" as const };

  it("awaits the observer so the metric is recorded before dispatch resolves", async () => {
    const metrics = new InMemoryMetricsStore();
    const state = new SqliteStateAdapter(":memory:");
    const dispatcher = new Dispatcher({
      store: state,
      handler: async () => {},
      observer: createDispatchObserver(metrics),
      sleep: async () => {},
    });

    await dispatcher.dispatch(toDispatchEvent(ciEvent));

    expect(metrics.getRecords()).toHaveLength(1);
    expect(metrics.successRateByType("dispatch")).toBeCloseTo(1, 2);
    state.close?.();
  });

  it("counts retries as fix cycles for the completed dispatch task", async () => {
    const metrics = new InMemoryMetricsStore();
    const state = new SqliteStateAdapter(":memory:");
    let attempts = 0;
    const dispatcher = new Dispatcher({
      store: state,
      policy: { maxRetries: 2, baseDelayMs: 1, backoffMultiplier: 2 },
      handler: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("flaky runner");
      },
      observer: createDispatchObserver(metrics),
      sleep: async () => {},
    });

    await dispatcher.dispatch(toDispatchEvent(ciEvent));

    expect(metrics.getRecords()).toEqual([
      { taskType: "dispatch", iterations: 2, fixCycles: 1, status: "success" },
    ]);
    state.close?.();
  });

  it("records an exhausted dispatch as a failed task of its own type", async () => {
    const metrics = new InMemoryMetricsStore();
    const state = new SqliteStateAdapter(":memory:");
    const dispatcher = new Dispatcher({
      store: state,
      policy: { maxRetries: 1, baseDelayMs: 1, backoffMultiplier: 2 },
      handler: async () => {
        throw new Error("runner down");
      },
      observer: createDispatchObserver(metrics),
      sleep: async () => {},
    });

    await dispatcher.dispatch(toDispatchEvent(ciEvent));

    expect(metrics.getRecords()).toEqual([
      { taskType: "dispatch", iterations: 2, fixCycles: 1, status: "failure" },
    ]);
    expect(metrics.successRateByType("dispatch")).toBeCloseTo(0, 2);
    state.close?.();
  });
});

describe("state DB path hardening (reviewer follow-up)", () => {
  const dirs: string[] = [];
  const makeRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "df-sandbox-"));
    dirs.push(root);
    return root;
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it("refuses a path that escapes the configured DF_STATE_DB_DIR sandbox", () => {
    const root = makeRoot();

    expect(() =>
      createStateStore({
        DF_STATE_DRIVER: "sqlite",
        DF_STATE_DB_PATH: join(root, "..", "escape.sqlite"),
        DF_STATE_DB_DIR: root,
      }),
    ).toThrow(/DF_STATE_DB_DIR/);
  });

  it("canonicalises a traversal path that stays inside the sandbox", async () => {
    const root = makeRoot();
    const store = createStateStore({
      DF_STATE_DRIVER: "sqlite",
      DF_STATE_DB_PATH: join(root, "nested", "..", "state.sqlite"),
      DF_STATE_DB_DIR: root,
    });

    expect(store.id).toBe("sqlite");
    expect((await saveContext(store, ctx)).ok).toBe(true);
    store.close?.();
  });

  it("matches the platform's case sensitivity for the sandbox root", () => {
    const root = makeRoot();
    const env = {
      DF_STATE_DRIVER: "sqlite",
      DF_STATE_DB_DIR: root.toUpperCase(),
      DF_STATE_DB_PATH: join(root, "state.sqlite"),
    };

    if (process.platform === "win32") {
      // Windows filesystems are case-INsensitive, so C:\x IS c:\x: this path is
      // inside the sandbox and must not be refused.
      const store = createStateStore(env);
      expect(store.id).toBe("sqlite");
      store.close?.();
    } else {
      // POSIX is case-SENSITIVE: a differently-cased path is a different, and
      // therefore outside, location.
      expect(() => createStateStore(env)).toThrow(/DF_STATE_DB_DIR/);
    }
  });

  it("keeps the operator-trusted default when no sandbox root is set", () => {
    const root = makeRoot();
    const store = createStateStore({
      DF_STATE_DRIVER: "sqlite",
      DF_STATE_DB_PATH: join(root, "state.sqlite"),
    });

    expect(store.id).toBe("sqlite");
    store.close?.();
  });
});