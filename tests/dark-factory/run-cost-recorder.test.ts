import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { SqliteUsageStore } from "../../agent/lib/dark-factory/usage-store-sqlite";
import { recordRunActualCost } from "../../agent/lib/dark-factory/run-cost-recorder";

const MODEL = "deepseek/deepseek-v4.1-flash";
const at = "2026-10-29T11:19:35.479Z";
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "df-run-cost-w-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold the sqlite file briefly after close.
    }
  }
});

interface Fixture {
  runId: string;
  runHistory: SqliteRunHistoryStore;
  usage: SqliteUsageStore;
}

async function fixture(): Promise<Fixture> {
  const runHistory = new SqliteRunHistoryStore(join(tempDir(), "runs.db"), () => `run-${randomUUID()}`);
  const usage = new SqliteUsageStore(join(tempDir(), "usage.db"));
  const accepted = await runHistory.acceptDelivery({
    deliveryId: `rec-${randomUUID()}`,
    repo: `owner/rec-${randomUUID().slice(0, 8)}`,
    issue: 531,
    receivedAt: at,
  });
  return { runId: accepted.value?.runId as string, runHistory, usage };
}

/** A ledger row, as the architect's call records one (#492). */
async function ledgerSpend(f: Fixture, costUsd: number, taskType = "architect"): Promise<void> {
  await f.usage.record({
    runId: f.runId,
    taskType,
    model: MODEL,
    tokensIn: 1000,
    tokensOut: 500,
    costUsd,
    ts: at,
  });
}

/** A gateway cost event, which is the other subsystem (they never overlap). */
async function eventSpend(f: Fixture, costUsd: number): Promise<void> {
  await f.runHistory.appendEvent({
    eventId: `evt-${randomUUID()}`,
    runId: f.runId,
    type: "run.cost",
    stage: "worker",
    status: "running",
    occurredAt: at,
    costUsd,
  });
}

describe("record a run's actual cost (#531)", () => {
  it("reads the LEDGER alone once the gateway records usage there too (#532)", async () => {
    const f = await fixture();
    await ledgerSpend(f, 0.09);
    await eventSpend(f, 0.4);

    const result = await recordRunActualCost(f, f.runId);

    expect(result.ok).toBe(true);
    // The ledger is the one source now: adding the event as well would count the same spend twice.
    expect(result.actual?.costUsd).toBeCloseTo(0.09, 10);
    expect(result.actual?.costUsd).not.toBeCloseTo(0.49, 10);
    expect((await f.runHistory.getRun(f.runId)).value?.costUsd).toBeCloseTo(0.09, 10);
    await f.runHistory.close();
    await f.usage.close();
  });

  it("writes a ledger-only run, which is what an in-process run looks like today", async () => {
    const f = await fixture();
    await ledgerSpend(f, 0.0932);

    await recordRunActualCost(f, f.runId);

    expect((await f.runHistory.getRun(f.runId)).value?.costUsd).toBeCloseTo(0.0932, 10);
    await f.runHistory.close();
    await f.usage.close();
  });

  it("writes nothing for an event-only run, leaving the store's own fold alone", async () => {
    const f = await fixture();
    await eventSpend(f, 0.4);

    const result = await recordRunActualCost(f, f.runId);

    // The RECORDER writes nothing: with no ledger row the run is unmeasured rather than estimated,
    // because an estimate recorded as an actual is worse than no number at all.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-measured");
    // What is on the run is the run history's own doing (#281 folds a cost event onto its run), not
    // this writer's — and when the ledger DOES have a figure, the writer replaces that fold, which is
    // why the both-sources case above totals the ledger rather than the two.
    expect((await f.runHistory.getRun(f.runId)).value?.costUsd).toBeCloseTo(0.4, 10);
    await f.runHistory.close();
    await f.usage.close();
  });

  it("writes NOTHING when neither source recorded anything — unmeasured, not zero", async () => {
    const f = await fixture();

    const result = await recordRunActualCost(f, f.runId);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-measured");
    expect((await f.runHistory.getRun(f.runId)).value?.costUsd).toBeUndefined();
    await f.runHistory.close();
    await f.usage.close();
  });

  it("excludes the tester, matching the estimator's own scope and ADR 0074", async () => {
    const f = await fixture();
    await ledgerSpend(f, 0.09);
    await ledgerSpend(f, 5, "tester");

    await recordRunActualCost(f, f.runId);

    expect((await f.runHistory.getRun(f.runId)).value?.costUsd).toBeCloseTo(0.09, 10);
    await f.runHistory.close();
    await f.usage.close();
  });

  it("recomputes rather than accumulates, so running it twice is stable", async () => {
    const f = await fixture();
    await ledgerSpend(f, 0.09);

    await recordRunActualCost(f, f.runId);
    await recordRunActualCost(f, f.runId);

    expect((await f.runHistory.getRun(f.runId)).value?.costUsd).toBeCloseTo(0.09, 10);
    await f.runHistory.close();
    await f.usage.close();
  });

  it("REPORTS a write failure instead of throwing — a run must not die over bookkeeping", async () => {
    const f = await fixture();
    await ledgerSpend(f, 0.09);
    vi.spyOn(f.runHistory, "recordRunCost").mockResolvedValue({
      ok: false,
      mode: "blocked",
      providerId: "stub",
      error: "ledger unavailable",
    });

    const result = await recordRunActualCost(f, f.runId);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("write-failed");
    expect(result.error).toContain("ledger unavailable");
    await f.runHistory.close();
    await f.usage.close();
  });

  it("REPORTS an unreadable ledger instead of throwing", async () => {
    const f = await fixture();
    await ledgerSpend(f, 0.09);
    // Any access to the ledger throws, so the READ path is what fails — mocking `record` would have
    // proven nothing, because the read never calls it.
    const brokenUsage = new Proxy(
      {},
      {
        get: () => {
          throw new Error("ledger down");
        },
      },
    ) as unknown as SqliteUsageStore;

    const result = await recordRunActualCost({ runHistory: f.runHistory, usage: brokenUsage }, f.runId);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("usage-unreadable");
    expect(result.error).toContain("ledger down");
    await f.runHistory.close();
    await f.usage.close();
  });
});
