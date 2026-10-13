import { beforeAll, describe, expect, it } from "vitest";
import { PostgresControlAdapter } from "../../agent/lib/dark-factory/control-postgres";
import { PG_TABLES, resetPgTables } from "./pg-test-helpers";

const databaseUrl = process.env.DF_CONTROL_DATABASE_URL ?? process.env.DF_RUN_HISTORY_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("PostgresControlAdapter", () => {
  // #332: start from this suite's OWN empty tables, so leftovers cannot flake it.
  beforeAll(async () => {
    await resetPgTables(databaseUrl as string, PG_TABLES.control);
  });

  it("upserts factory/run state and persists audit events", async () => {
    const store = new PostgresControlAdapter(databaseUrl!);
    const now = new Date().toISOString();
    const runId = `control-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      const factory = { paused: true, updatedAt: now, actor: "test-operator" };
      expect((await store.writeFactory(factory)).ok).toBe(true);
      expect((await store.readFactory()).value).toEqual(factory);
      const resumed = { ...factory, paused: false };
      expect((await store.writeFactory(resumed)).ok).toBe(true);
      expect((await store.readFactory()).value).toEqual(resumed);

      const run = { paused: true, stopped: false, updatedAt: now, actor: "test-operator" };
      expect((await store.writeRun(runId, run)).ok).toBe(true);
      expect((await store.readRun(runId)).value).toEqual(run);

      const event = { at: now, actor: "test-operator", action: "pause" as const, scope: "run" as const, runId };
      expect((await store.appendEvent(event)).ok).toBe(true);
      const events = await store.listEvents(20);
      expect(events.ok).toBe(true);
      expect(events.value).toContainEqual(event);
    } finally {
      await store.close();
    }
  });
});
