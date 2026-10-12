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
import { DatabaseSync } from "node:sqlite";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold the sqlite file briefly after close; a temp dir is not worth failing on.
    }
  }
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

// ---------------------------------------------------------------------------
// #328 — the repair must NAME the runs it terminated (operator traceability)
// ---------------------------------------------------------------------------

describe("#328 repair logging", () => {
  it("names the terminated runs so an operator can trace them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "df-claim-log-"));
    dirs.push(dir);
    const path = join(dir, "runs.db");
    const first = new SqliteRunHistoryStore(path, () => "active-run");
    const accepted = await first.acceptDelivery({
      deliveryId: "log-d1",
      repo: "owner/log",
      issue: 328,
      receivedAt: at,
    });
    const keptRunId = accepted.value?.runId;
    expect(keptRunId).toBe("active-run");
    await first.close();

    // Force the state the claim forbids: drop the index, then copy the ACTIVE run under a new id
    // with an OLDER created_at, so the original is the run that survives the repair.
    const raw = new DatabaseSync(path);
    raw.exec("DROP INDEX IF EXISTS df_run_active_issue_uidx");
    const columns = (
      raw.prepare("PRAGMA table_info(df_run_summaries)").all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    const source = raw
      .prepare("SELECT * FROM df_run_summaries WHERE run_id = ?")
      .get(keptRunId as string) as Record<string, unknown>;
    const duplicate: Record<string, unknown> = {
      ...source,
      run_id: "duplicate-run",
      created_at: "2020-01-01T00:00:00.000Z",
    };
    raw
      .prepare(
        `INSERT INTO df_run_summaries (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      )
      .run(...columns.map((column) => duplicate[column] as never));
    raw.close();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let reopened: SqliteRunHistoryStore | undefined;
    try {
      reopened = new SqliteRunHistoryStore(path, () => "unused");
      await reopened.getRun("duplicate-run"); // forces the schema pass, including the repair

      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("terminated 1 older duplicate ACTIVE run");
      expect(logged).toContain("duplicate-run");
      expect(logged).toContain("owner/log#328");

      const loser = await reopened.getRun("duplicate-run");
      const survivor = await reopened.getRun(keptRunId as string);
      expect(loser.value?.status).toBe("aborted");
      expect(survivor.value?.status).toBe("queued");
    } finally {
      warn.mockRestore();
      await reopened?.close();
    }
  });
});
