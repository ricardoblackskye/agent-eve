import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConsoleControlProvider,
  InvalidControlError,
  SqliteControlAdapter,
  toControlEvent,
} from "../../agent/lib/dark-factory/control";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("toControlEvent", () => {
  it("normalizes a valid run-scoped control event", () => {
    expect(
      toControlEvent({
        actor: "operator@example.test",
        action: "pause",
        scope: "run",
        runId: "run-42",
        reason: "investigating",
        at: "2026-09-29T10:00:00.000Z",
      }),
    ).toEqual({
      actor: "operator@example.test",
      action: "pause",
      scope: "run",
      runId: "run-42",
      reason: "investigating",
      at: "2026-09-29T10:00:00.000Z",
    });
  });

  it.each([
    ["missing actor", { action: "pause", scope: "factory" }],
    ["unknown action", { actor: "operator", action: "kill", scope: "factory" }],
    ["unknown scope", { actor: "operator", action: "pause", scope: "global" }],
    ["missing run id", { actor: "operator", action: "pause", scope: "run" }],
  ])("rejects %s", (_case, input) => {
    expect(() => toControlEvent(input)).toThrow(InvalidControlError);
  });
});

describe("control stores", () => {
  it("console provider refuses reads and writes", async () => {
    const store = new ConsoleControlProvider();
    const read = await store.readFactory();
    const write = await store.writeFactory({ paused: true, updatedAt: "2026-09-29T10:00:00.000Z" });
    expect(read).toMatchObject({ ok: false, mode: "blocked", providerId: "console", value: null });
    expect(read.error).toMatch(/not configured/i);
    expect(write).toMatchObject({ ok: false, mode: "blocked", providerId: "console" });
  });

  it("round-trips factory and per-run state, and lists audit events newest-first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "df-control-"));
    tempDirs.push(dir);
    const store = new SqliteControlAdapter(join(dir, "control.sqlite"));
    try {
      const factory = { paused: true, updatedAt: "2026-09-29T10:00:00.000Z", actor: "operator" };
      const run = { paused: true, stopped: false, updatedAt: factory.updatedAt, actor: "operator" };
      expect((await store.writeFactory(factory)).ok).toBe(true);
      expect((await store.readFactory()).value).toEqual(factory);
      expect((await store.writeRun("run-42", run)).ok).toBe(true);
      expect((await store.readRun("run-42")).value).toEqual(run);
      expect((await store.readRun("missing")).value).toBeNull();
      const first = { at: factory.updatedAt, actor: "operator", action: "pause" as const, scope: "factory" as const };
      const second = { ...first, at: "2026-09-29T10:01:00.000Z", action: "resume" as const };
      expect((await store.appendEvent(first)).ok).toBe(true);
      expect((await store.appendEvent(second)).ok).toBe(true);
      expect((await store.listEvents()).value).toEqual([second, first]);
    } finally {
      store.close();
    }
  });

  it("reports a missing nested SQLite path as unavailable", async () => {
    const dir = join(tmpdir(), `df-control-absent-${Date.now()}`, "nested");
    const store = new SqliteControlAdapter(join(dir, "control.sqlite"));
    const result = await store.readFactory();
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("blocked");
    expect(result.error).toMatch(/unreachable|ENOENT/i);
    store.close();
  });
});
