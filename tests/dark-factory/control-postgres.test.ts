import { describe, expect, it } from "vitest";
import { PostgresControlAdapter } from "../../agent/lib/dark-factory/control-postgres";
import { assertDisposableDsn, testDsnFor } from "./pg-test-helpers";

// #409: this suite reads its OWN test variable, like its six siblings. It used to fall back to the
// production-shaped DF_CONTROL_DATABASE_URL, which made it skip in every local run and left it able to write to a
// live database. The global setup prepares the control tables in the schema this derives.
const baseDsn = process.env.DF_CONTROL_TEST_DATABASE_URL;
const databaseUrl = baseDsn ? testDsnFor(baseDsn, "control") : undefined;
if (databaseUrl) assertDisposableDsn(databaseUrl);
const integration = databaseUrl ? describe : describe.skip;

integration("PostgresControlAdapter", () => {
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
