import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateStore, createRetryPolicy } from "../../agent/lib/dark-factory/index";
import { toExecutionContext, saveContext, loadContext } from "../../agent/lib/dark-factory/state";
import { DEFAULT_RETRY_POLICY } from "../../agent/lib/dark-factory/dispatch";

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