import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { buildRunControl, resolveRunnerRunId } from "../../scripts/dark-factory-runner";
import { performControlAction } from "../../agent/lib/dark-factory/control-service";

function sqliteEnv(dbPath: string): Record<string, string | undefined> {
  return { DF_CONTROL_DRIVER: "sqlite", DF_CONTROL_DB_PATH: dbPath, NODE_ENV: "test" };
}

describe("runner buildRunControl", () => {
  it("uses an explicit run ID or creates a unique default shared with run history", () => {
    expect(resolveRunnerRunId(["node", "runner", "--run-id", "history-id"], 42, 1234)).toBe("history-id");
    expect(resolveRunnerRunId(["node", "runner"], 42, 1234)).toBe("run-42-1234");
  });

  it("builds a checkpoint that allows work when the factory is running", async () => {
    const dbPath = join(tmpdir(), `df-run-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
    const { store, checkpoint } = buildRunControl(sqliteEnv(dbPath), "run-1");
    await expect(checkpoint()).resolves.toBeUndefined();
    await performControlAction(store, {
      action: "pause",
      scope: "factory",
      actor: "operator",
      reason: "operator",
    });
    await expect(checkpoint()).rejects.toMatchObject({ name: "PausedRunError" });
    store.close?.();
    await fs.rm(dbPath, { force: true });
  });

  it("gates a per-run stop at the developer boundary", async () => {
    const dbPath = join(tmpdir(), `df-run-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
    const { store, checkpoint } = buildRunControl(sqliteEnv(dbPath), "run-42");
    await performControlAction(store, {
      action: "stop",
      scope: "run",
      runId: "run-42",
      actor: "operator",
      reason: "operator",
    });
    await expect(checkpoint()).rejects.toMatchObject({ name: "StoppedRunError" });
    store.close?.();
    await fs.rm(dbPath, { force: true });
  });
});
