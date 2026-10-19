/**
 * #404 R2 — retiring the claim a stopped run holds.
 *
 * R1's acceptance exposed this: a run that parks (or dies) keeps holding its issue's claim (ADR 0026), so a clean
 * re-run is REFUSED, and the only way past it was dropping the scratch database. R2 gives the operator a named way
 * to let go.
 *
 * The property that matters most is the one the tests below defend first: **retiring a LIVE holder is refused.**
 * A `running` run is work in flight; cutting the claim from under it would put two agents on one issue — exactly
 * what the claim exists to prevent. A `blocked` (parked) run may be retired precisely because a park is a WAIT.
 *
 * Like the #328 suite, the same assertions run against BOTH stores so the drivers cannot diverge.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

import { PostgresRunHistoryStore } from "../../agent/lib/dark-factory/run-history-postgres";
import { pgTableExists } from "./pg-test-helpers";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import type { RunSummary } from "../../agent/lib/dark-factory/run-history";

const at = "2026-10-19T12:00:00.000Z";
/** Per-run namespace: the Postgres database persists between runs, and a leftover ACTIVE run would otherwise
 * block the first delivery of the next run. */
const ns = randomUUID().slice(0, 8);
const dirs: string[] = [];

function makeSqlite(): SqliteRunHistoryStore {
  const dir = mkdtempSync(join(tmpdir(), "df-retire-"));
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

function summaryFor(repo: string, issue: number, runId: string, status: RunSummary["status"]): RunSummary {
  return {
    runId,
    repo,
    issue,
    status,
    stage: status === "running" ? "dispatch" : "worker",
    createdAt: at,
    updatedAt: at,
    attemptCount: 0,
    reviewCount: 0,
    iterationCount: 0,
    fixCycleCount: 0,
  };
}

function retireSuite(
  name: string,
  makeStore: () => SqliteRunHistoryStore | PostgresRunHistoryStore,
) {
  describe(name, () => {
    it("retires a PARKED run's claim, so a NEW run can start, and KEEPS the record", async () => {
      const store = makeStore();
      const repo = `owner/retire-a-${name}-${ns}`;
      const first = await store.acceptDelivery({
        deliveryId: `${name}-a1-${randomUUID()}`,
        repo,
        issue: 404,
        receivedAt: at,
      });
      const runId = first.value?.runId as string;
      // Park it: the state a run holds while it waits for a human (ADR 0041).
      await store.appendEvent({
        eventId: `${name}-a-question-${randomUUID()}`,
        runId,
        type: "worker.question",
        stage: "worker",
        occurredAt: at,
        status: "blocked",
      });

      const result = await store.retireRunClaim({ repo, issue: 404, actor: "operator" });

      expect(result.ok).toBe(true);
      expect(result.value?.outcome).toBe("retired");
      if (result.value?.outcome === "retired") {
        expect(result.value.runId).toBe(runId);
        expect(result.value.previousStatus).toBe("blocked");
      }

      // The claim is RELEASED: the very next delivery starts a new run.
      const next = await store.acceptDelivery({
        deliveryId: `${name}-a2-${randomUUID()}`,
        repo,
        issue: 404,
        receivedAt: at,
      });
      expect(next.value).toBeDefined();
      expect(next.activeConflict).toBeUndefined();

      // The record SURVIVES and explains itself: terminal, completed, with an event naming the cause.
      const after = await store.getRun(runId);
      expect(after.value?.status).toBe("aborted");
      expect(after.value?.completedAt).toBeDefined();
      const events = await store.listRunEvents(runId, { limit: 50 });
      const terminal = events.value?.items.find((e) => e.event.type === "run.terminal");
      expect(terminal).toBeDefined();
      expect(terminal?.event.eventId).toContain("retire");
      await store.close();
    });

    it("REFUSES to retire a LIVE (running) holder, and changes NOTHING", async () => {
      const store = makeStore();
      const repo = `owner/retire-b-${name}-${ns}`;
      const first = await store.acceptDelivery({
        deliveryId: `${name}-b1-${randomUUID()}`,
        repo,
        issue: 404,
        receivedAt: at,
      });
      const runId = first.value?.runId as string;
      await store.recordRunSummary(summaryFor(repo, 404, runId, "running"));

      const result = await store.retireRunClaim({ repo, issue: 404, actor: "operator" });

      expect(result.ok).toBe(true);
      expect(result.value?.outcome).toBe("holder-is-live");
      if (result.value?.outcome === "holder-is-live") {
        expect(result.value.runId).toBe(runId);
        expect(result.value.status).toBe("running");
      }

      // NOTHING changed: the holder is still running and still holds the claim.
      const after = await store.getRun(runId);
      expect(after.value?.status).toBe("running");
      expect(after.value?.completedAt).toBeUndefined();
      const second = await store.acceptDelivery({
        deliveryId: `${name}-b2-${randomUUID()}`,
        repo,
        issue: 404,
        receivedAt: at,
      });
      expect(second.activeConflict?.runId).toBe(runId);
      await store.close();
    });

    it("reports NO CLAIM rather than silently succeeding", async () => {
      const store = makeStore();
      const result = await store.retireRunClaim({
        repo: `owner/retire-c-${name}-${ns}`,
        issue: 404,
        actor: "operator",
      });

      expect(result.ok).toBe(true);
      expect(result.value?.outcome).toBe("no-claim");
      await store.close();
    });

    it("finds the claim even when the CALLER passes MIXED CASE (the ledger stores the repo lowercased)", async () => {
      // The live acceptance caught this: the runner normalises the target repo to lowercase, so a retire that
      // compares the caller's raw casing matches nothing and reports no-claim while the ledger holds a claim.
      const store = makeStore();
      const repo = `owner/retire-case-${name}-${ns}`;
      const first = await store.acceptDelivery({
        deliveryId: `${name}-case1-${randomUUID()}`,
        repo,
        issue: 404,
        receivedAt: at,
      });
      const runId = first.value?.runId as string;
      await store.recordRunSummary(summaryFor(repo, 404, runId, "blocked"));

      const result = await store.retireRunClaim({
        repo: repo.toUpperCase(),
        issue: 404,
        actor: "operator",
      });

      expect(result.value?.outcome).toBe("retired");
      const after = await store.getRun(runId);
      expect(after.value?.status).toBe("aborted");
      await store.close();
    });

    it("is IDEMPOTENT: retiring an already-retired claim reports no-claim", async () => {
      const store = makeStore();
      const repo = `owner/retire-d-${name}-${ns}`;
      const first = await store.acceptDelivery({
        deliveryId: `${name}-d1-${randomUUID()}`,
        repo,
        issue: 404,
        receivedAt: at,
      });
      await store.recordRunSummary(summaryFor(repo, 404, first.value?.runId as string, "blocked"));

      const once = await store.retireRunClaim({ repo, issue: 404, actor: "operator" });
      const twice = await store.retireRunClaim({ repo, issue: 404, actor: "operator" });

      expect(once.value?.outcome).toBe("retired");
      expect(twice.value?.outcome).toBe("no-claim");
      await store.close();
    });
  });
}

retireSuite("sqlite", makeSqlite);

const dsn = process.env.DF_RUN_HISTORY_TEST_DATABASE_URL;
const describePg = dsn ? describe : describe.skip;
describePg("#404 R2 retire a claim (postgres)", () => {
  /**
   * This suite shares ONE database with the other Postgres suites. A run left ACTIVE by an earlier run would hold
   * the claim and make the first delivery of the next run fail for the wrong reason, so its own rows are cleared
   * before and after.
   */
  const clearRows = async (): Promise<void> => {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: dsn as string });
    await client.connect();
    try {
      // CI starts from a fresh database where the stores have not created these tables yet.
      if (!(await pgTableExists(client, "df_run_deliveries"))) return;
      await client.query(
        `DELETE FROM df_run_deliveries WHERE run_id IN
           (SELECT run_id FROM df_run_summaries WHERE repo LIKE 'owner/retire-%')`,
      );
      await client.query("DELETE FROM df_run_summaries WHERE repo LIKE 'owner/retire-%'");
    } finally {
      await client.end();
    }
  };

  beforeAll(clearRows);
  afterAll(clearRows);

  retireSuite("postgres", () => new PostgresRunHistoryStore(dsn as string));
});
