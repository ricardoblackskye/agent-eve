import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { PostgresRunHistoryStore } from "../../agent/lib/dark-factory/run-history-postgres";
import { pgTableExists, testDsnFor } from "./pg-test-helpers";

const at = "2026-10-29T10:00:00.000Z";
const ns = randomUUID().slice(0, 8);
const dirs: string[] = [];

function makeSqlite(): SqliteRunHistoryStore {
  const dir = mkdtempSync(join(tmpdir(), "df-runcost-"));
  dirs.push(dir);
  let n = 0;
  return new SqliteRunHistoryStore(join(dir, "runs.db"), () => `run-${++n}`);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold the sqlite file briefly after close; a temp dir is not worth failing on.
    }
  }
});

/** Shared assertions, run against BOTH stores so they cannot diverge (#323, #531). */
function runCostSuite(
  name: string,
  makeStore: () => SqliteRunHistoryStore | PostgresRunHistoryStore,
) {
  describe(name, () => {
    async function acceptedRun(
      store: SqliteRunHistoryStore | PostgresRunHistoryStore,
    ): Promise<string> {
      // A UNIQUE repo per call: the Postgres leg shares one database, and a run left holding the
      // claim by an earlier test would block this delivery (the sqlite leg's fresh file hides that).
      const accepted = await store.acceptDelivery({
        deliveryId: `runcost-${name}-${randomUUID()}`,
        repo: `owner/runcost-${name}-${ns}-${randomUUID().slice(0, 8)}`,
        issue: 531,
        receivedAt: at,
      });
      expect(accepted.ok).toBe(true);
      const runId = accepted.value?.runId;
      expect(runId).toBeDefined();
      return runId as string;
    }

    it("records a cost that reads back on the run", async () => {
      const store = makeStore();
      const runId = await acceptedRun(store);

      const written = await store.recordRunCost(runId, 0.42);
      expect(written.ok).toBe(true);
      expect(written.mode).toBe("live");

      const read = await store.getRun(runId);
      expect(read.value?.costUsd).toBeCloseTo(0.42, 10);
      await store.close();
    });

    it("REPLACES on a re-write rather than accumulating, because the value is the whole sum", async () => {
      const store = makeStore();
      const runId = await acceptedRun(store);

      await store.recordRunCost(runId, 0.42);
      await store.recordRunCost(runId, 0.11);

      const read = await store.getRun(runId);
      expect(read.value?.costUsd).toBeCloseTo(0.11, 10);
      expect(read.value?.costUsd).not.toBeCloseTo(0.53, 10);
      await store.close();
    });

    it("clears with null, which is NOT the same statement as zero", async () => {
      const store = makeStore();
      const runId = await acceptedRun(store);

      await store.recordRunCost(runId, 0.42);
      const cleared = await store.recordRunCost(runId, null);
      expect(cleared.ok).toBe(true);

      const read = await store.getRun(runId);
      expect(read.value?.costUsd).toBeUndefined();

      await store.recordRunCost(runId, 0);
      const zeroed = await store.getRun(runId);
      expect(zeroed.value?.costUsd).toBe(0);
      await store.close();
    });

    it("REFUSES a value that is not a usable cost, leaving the stored one untouched", async () => {
      const store = makeStore();
      const runId = await acceptedRun(store);
      await store.recordRunCost(runId, 0.42);

      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const refused = await store.recordRunCost(runId, bad);
        expect(refused.ok).toBe(false);
        expect(refused.error).toBeTruthy();
        const read = await store.getRun(runId);
        expect(read.value?.costUsd).toBeCloseTo(0.42, 10);
      }
      await store.close();
    });

    it("reports an unknown run as a failure rather than throwing", async () => {
      const store = makeStore();
      const missing = `absent-${randomUUID()}`;

      const result = await store.recordRunCost(missing, 0.5);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(missing);
      await store.close();
    });

    it("leaves every other field on the run alone — the narrow-update proof", async () => {
      const store = makeStore();
      const runId = await acceptedRun(store);
      const before = await store.getRun(runId);

      await store.recordRunCost(runId, 0.42);
      const after = await store.getRun(runId);

      expect(after.value?.status).toBe(before.value?.status);
      expect(after.value?.repo).toBe(before.value?.repo);
      expect(after.value?.issue).toBe(before.value?.issue);
      expect(after.value?.createdAt).toBe(before.value?.createdAt);
      await store.close();
    });
  });
}

runCostSuite("sqlite", makeSqlite);

const baseDsn = process.env.DF_RUN_HISTORY_TEST_DATABASE_URL;
// #392: this suite owns its own SCHEMA, so parallel workers cannot collide with another suite.
const dsn = baseDsn ? testDsnFor(baseDsn, "run_cost_record") : undefined;
const describePg = dsn ? describe : describe.skip;
describePg("#531 run cost (postgres)", () => {
  /** One database is shared with the other Postgres suites, so this one clears its own rows. */
  const clearRows = async (): Promise<void> => {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: dsn as string });
    await client.connect();
    try {
      if (!(await pgTableExists(client, "df_run_summaries"))) return;
      await client.query("DELETE FROM df_run_summaries WHERE repo LIKE 'owner/runcost-%'");
    } finally {
      await client.end();
    }
  };

  beforeAll(clearRows);
  afterAll(clearRows);

  runCostSuite("postgres", () => new PostgresRunHistoryStore(dsn as string));
});
