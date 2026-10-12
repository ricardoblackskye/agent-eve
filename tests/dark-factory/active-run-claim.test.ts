/**
 * #328 — the active-run claim is ATOMIC.
 *
 * The trigger path (`entry.ts:753-808`) guards only per DELIVERY, so before this
 * change a second, different delivery for the same repo+issue created a SECOND
 * run. The runner works on `process.cwd()` and the worker is honestly
 * `isolated: false`, so two runs on one clone share a working tree — mutual
 * exclusion is the isolation available today.
 *
 * The claim is enforced by a partial UNIQUE index in the store, so these tests
 * assert the STORE's behaviour (the atomic layer), not a caller's SELECT.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PostgresRunHistoryStore } from "../../agent/lib/dark-factory/run-history-postgres";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const at = "2026-10-12T10:00:00.000Z";
/** Per-run namespace: the Postgres DB persists between runs, and a leftover ACTIVE run would
 * otherwise block the first delivery of the next run. */
const ns = randomUUID().slice(0, 8);
const dirs: string[] = [];

function makeSqlite(): SqliteRunHistoryStore {
  const dir = mkdtempSync(join(tmpdir(), "df-claim-"));
  dirs.push(dir);
  let n = 0;
  return new SqliteRunHistoryStore(join(dir, "runs.db"), () => `run-${++n}`);
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Shared assertions, run against BOTH stores so they cannot diverge. */
function claimSuite(
  name: string,
  makeStore: () => SqliteRunHistoryStore | PostgresRunHistoryStore,
) {
  describe(name, () => {
    it("refuses a SECOND delivery for the same repo+issue, NAMING the existing run", async () => {
      const store = makeStore();
      const first = await store.acceptDelivery({
        deliveryId: `${name}-d1-${randomUUID()}`,
        repo: `owner/claim-a-${name}-${ns}`,
        issue: 328,
        receivedAt: at,
      });
      expect(first.ok).toBe(true);
      const runId = first.value?.runId;
      expect(runId).toBeDefined();

      const second = await store.acceptDelivery({
        deliveryId: `${name}-d2-${randomUUID()}`,
        repo: `owner/claim-a-${name}-${ns}`,
        issue: 328,
        receivedAt: at,
      });

      // Handled, not an error: no second run was created, and the existing run is NAMED.
      expect(second.ok).toBe(true);
      expect(second.value).toBeUndefined();
      expect(second.activeConflict?.runId).toBe(runId);
      expect(second.activeConflict?.status).toBe("queued");
      await store.close();
    });

    it("does NOT block a different issue, or a different repo", async () => {
      const store = makeStore();
      const base = `owner/claim-b-${name}-${ns}`;
      await store.acceptDelivery({
        deliveryId: `${name}-b1-${randomUUID()}`,
        repo: base,
        issue: 328,
        receivedAt: at,
      });

      const otherIssue = await store.acceptDelivery({
        deliveryId: `${name}-b2-${randomUUID()}`,
        repo: base,
        issue: 999,
        receivedAt: at,
      });
      const otherRepo = await store.acceptDelivery({
        deliveryId: `${name}-b3-${randomUUID()}`,
        repo: `owner/claim-b2-${name}-${ns}`,
        issue: 328,
        receivedAt: at,
      });

      expect(otherIssue.value).toBeDefined();
      expect(otherRepo.value).toBeDefined();
      await store.close();
    });

    it("RELEASES the claim on a terminal transition (so the #307 rerun still works)", async () => {
      const store = makeStore();
      const repo = `owner/claim-c-${name}-${ns}`;
      const first = await store.acceptDelivery({
        deliveryId: `${name}-c1-${randomUUID()}`,
        repo,
        issue: 328,
        receivedAt: at,
      });
      const runId = first.value?.runId as string;
      const terminal = await store.appendEvent({
        eventId: `${name}-c-terminal-${randomUUID()}`,
        runId,
        type: "run.terminal",
        stage: "terminal",
        occurredAt: at,
        status: "failed",
      });
      expect(terminal.ok).toBe(true);

      const rerun = await store.acceptDelivery({
        deliveryId: `${name}-c2-${randomUUID()}`,
        repo,
        issue: 328,
        receivedAt: at,
      });
      expect(rerun.value).toBeDefined(); // a NEW run is allowed once the old one is terminal
      await store.close();
    });

    it("KEEPS the claim while the run is blocked (parked awaiting a human)", async () => {
      const store = makeStore();
      const repo = `owner/claim-d-${name}-${ns}`;
      const first = await store.acceptDelivery({
        deliveryId: `${name}-d-${randomUUID()}`,
        repo,
        issue: 328,
        receivedAt: at,
      });
      const runId = first.value?.runId as string;
      const parked = await store.appendEvent({
        eventId: `${name}-d-question-${randomUUID()}`,
        runId,
        type: "worker.question",
        stage: "worker",
        occurredAt: at,
        status: "blocked",
      });
      expect(parked.ok).toBe(true);

      const second = await store.acceptDelivery({
        deliveryId: `${name}-d2-${randomUUID()}`,
        repo,
        issue: 328,
        receivedAt: at,
      });
      expect(second.activeConflict?.runId).toBe(runId);
      await store.close();
    });

    it("is ATOMIC: two simultaneous deliveries create exactly ONE run", async () => {
      const store = makeStore();
      const repo = `owner/claim-e-${name}-${ns}`;
      const results = await Promise.all([
        store.acceptDelivery({
          deliveryId: `${name}-e1-${randomUUID()}`,
          repo,
          issue: 328,
          receivedAt: at,
        }),
        store.acceptDelivery({
          deliveryId: `${name}-e2-${randomUUID()}`,
          repo,
          issue: 328,
          receivedAt: at,
        }),
      ]);

      const created = results.filter((r) => r.value !== undefined);
      const refused = results.filter((r) => r.activeConflict !== undefined);
      expect(created).toHaveLength(1);
      expect(refused).toHaveLength(1);
      await store.close();
    });
  });
}

claimSuite("sqlite", makeSqlite);

const dsn = process.env.DF_RUN_HISTORY_TEST_DATABASE_URL;
const describePg = dsn ? describe : describe.skip;
describePg("#328 active-run claim (postgres)", () => {
  /**
   * This suite shares ONE database with the other Postgres suites. A run left ACTIVE by an earlier
   * run would hold the claim and make the first delivery of the next run fail for the wrong reason,
   * so the suite is made HERMETIC: its own rows are cleared before and after.
   */
  const clearClaimRows = async (): Promise<void> => {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: dsn as string });
    await client.connect();
    try {
      await client.query(
        `DELETE FROM df_run_deliveries WHERE run_id IN
           (SELECT run_id FROM df_run_summaries WHERE repo LIKE 'owner/claim-%')`,
      );
      await client.query(
        "DELETE FROM df_run_summaries WHERE repo LIKE 'owner/claim-%'",
      );
    } finally {
      await client.end();
    }
  };

  beforeAll(clearClaimRows);
  afterAll(clearClaimRows);

  claimSuite("postgres", () => new PostgresRunHistoryStore(dsn as string));
});
