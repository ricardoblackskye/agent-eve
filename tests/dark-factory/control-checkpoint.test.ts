import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import {
  createControlStore,
  SqliteControlAdapter,
  type ControlStore,
} from "../../agent/lib/dark-factory/control";
import { performControlAction } from "../../agent/lib/dark-factory/control-service";
import { ControlUnavailableError, createControlCheckpoint } from "../../agent/lib/dark-factory/control-checkpoint";

function memoryStore(): ControlStore {
  return new SqliteControlAdapter(":memory:");
}

describe("createControlCheckpoint", () => {
  it("passes when factory and run are running", async () => {
    const store = memoryStore();
    const checkpoint = createControlCheckpoint(store, "run-1");
    await expect(checkpoint()).resolves.toBeUndefined();
  });

  it("throws PausedRunError when the factory is paused", async () => {
    const store = memoryStore();
    await performControlAction(store, {
      action: "pause",
      scope: "factory",
      actor: "operator",
      reason: "operator",
    });
    const checkpoint = createControlCheckpoint(store, "run-1");
    await expect(checkpoint()).rejects.toMatchObject({ name: "PausedRunError" });
  });

  it("throws StoppedRunError when the run is stopped", async () => {
    const store = memoryStore();
    await performControlAction(store, {
      action: "stop",
      scope: "run",
      runId: "run-1",
      actor: "operator",
      reason: "operator",
    });
    const checkpoint = createControlCheckpoint(store, "run-1");
    await expect(checkpoint()).rejects.toMatchObject({ name: "StoppedRunError" });
  });

  it("resumes after the factory is paused then resumed", async () => {
    const store = memoryStore();
    await performControlAction(store, {
      action: "pause",
      scope: "factory",
      actor: "operator",
      reason: "operator",
    });
    const checkpoint = createControlCheckpoint(store, "run-1");
    await expect(checkpoint()).rejects.toMatchObject({ name: "PausedRunError" });
    await performControlAction(store, {
      action: "resume",
      scope: "factory",
      actor: "operator",
      reason: "operator",
    });
    await expect(checkpoint()).resolves.toBeUndefined();
  });

  it("works against a file-backed sqlite store (runner driver path)", async () => {
    const dbPath = join(tmpdir(), `df-ckpt-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
    const store = new SqliteControlAdapter(dbPath);
    const checkpoint = createControlCheckpoint(store, "run-7");
    await expect(checkpoint()).resolves.toBeUndefined();
    await performControlAction(store, {
      action: "stop",
      scope: "run",
      runId: "run-7",
      actor: "operator",
      reason: "operator",
    });
    await expect(checkpoint()).rejects.toMatchObject({ name: "StoppedRunError" });
    store.close();
    await fs.rm(dbPath, { force: true });
  });

  it("selects the sqlite driver from environment config (runner factory path)", async () => {
    const dbPath = join(tmpdir(), `df-env-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
    const store = createControlStore({
      DF_CONTROL_DRIVER: "sqlite",
      DF_CONTROL_DB_PATH: dbPath,
      NODE_ENV: "test",
    });
    const checkpoint = createControlCheckpoint(store, "run-9");
    await expect(checkpoint()).resolves.toBeUndefined();
    store.close?.();
    await fs.rm(dbPath, { force: true });
  });

  it("throws ControlUnavailableError when the store throws", async () => {
    const store = memoryStore();
    const failing: ControlStore = {
      ...store,
      async readFactory() {
        throw new Error("boom");
      },
    };
    const checkpoint = createControlCheckpoint(failing, "run-1");
    await expect(checkpoint()).rejects.toBeInstanceOf(ControlUnavailableError);
  });
});
