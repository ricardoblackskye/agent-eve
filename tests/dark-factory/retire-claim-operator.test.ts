/**
 * #404 R2 Task 3/4/7 — the operator's retire: the ledger lets go, and the TICKET stops lying.
 *
 * Two refusals matter as much as the success:
 *  - a LIVE holder is refused, and NO label is touched (a refusal must not leave the ticket half-changed);
 *  - finding no claim is refused, not reported as success.
 *
 * The store is the REAL sqlite store (fast, and it is the driver a local run uses), so these tests exercise the
 * actual retirement transition rather than a stub's idea of one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { retireStaleClaim } from "../../agent/lib/dark-factory/retire-claim";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { ConsoleRunHistoryStore } from "../../agent/lib/dark-factory/run-history-provider";
import { TRIGGER_LABELS } from "../../agent/lib/dark-factory/trigger";
import type { LabelWriter } from "../../agent/lib/dark-factory/definition-of-done";

const at = "2026-10-19T13:00:00.000Z";
const dirs: string[] = [];

function makeStore(): SqliteRunHistoryStore {
  const dir = mkdtempSync(join(tmpdir(), "df-retire-op-"));
  dirs.push(dir);
  let n = 0;
  return new SqliteRunHistoryStore(join(dir, "runs.db"), () => `run-${++n}`);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold the sqlite file briefly after close.
    }
  }
});

/** Records what the operator's action would have done to the ticket. */
function fakeLabels(options: { failOn?: string } = {}) {
  const removed: string[] = [];
  const added: string[] = [];
  const writer: LabelWriter = {
    add: vi.fn(async (_repo, _issue, label: string) => {
      if (options.failOn === label) return { ok: false, error: `refused to add ${label}` };
      added.push(label);
      return { ok: true };
    }),
    remove: vi.fn(async (_repo, _issue, label: string) => {
      if (options.failOn === label) return { ok: false, error: `refused to remove ${label}` };
      removed.push(label);
      return { ok: true };
    }),
  };
  return { writer, removed, added };
}

async function seedParkedRun(store: SqliteRunHistoryStore, repo: string, issue: number) {
  const accepted = await store.acceptDelivery({
    deliveryId: `d-${repo}-${issue}`,
    repo,
    issue,
    receivedAt: at,
  });
  const runId = accepted.value?.runId as string;
  await store.appendEvent({
    eventId: `q-${runId}`,
    runId,
    type: "worker.question",
    stage: "worker",
    occurredAt: at,
    status: "blocked",
  });
  return runId;
}

describe("#404 R2 Task 3/4 - retireStaleClaim", () => {
  it("retires a parked claim AND clears the factory's live labels", async () => {
    const store = makeStore();
    const repo = "owner/op-a";
    const runId = await seedParkedRun(store, repo, 404);
    const labels = fakeLabels();

    const report = await retireStaleClaim({ store, labels: labels.writer }, { repo, issue: 404, actor: "operator" });

    expect(report.outcome).toBe("retired");
    expect(report.runId).toBe(runId);
    expect(report.previousStatus).toBe("blocked");
    expect([...report.clearedLabels].sort()).toEqual(
      [TRIGGER_LABELS.running, TRIGGER_LABELS.question].sort(),
    );
    for (const label of report.clearedLabels) {
      expect(labels.removed).toContain(label);
    }
    // The ledger really did retire it.
    const after = await store.getRun(runId);
    expect(after.value?.status).toBe("aborted");
    await store.close();
  });

  it("REFUSES a live holder and touches NO label", async () => {
    const store = makeStore();
    const repo = "owner/op-b";
    const accepted = await store.acceptDelivery({ deliveryId: "d-b", repo, issue: 404, receivedAt: at });
    const runId = accepted.value?.runId as string;
    await store.recordRunSummary({
      runId,
      repo,
      issue: 404,
      status: "running",
      stage: "dispatch",
      createdAt: at,
      updatedAt: at,
      attemptCount: 0,
      reviewCount: 0,
      iterationCount: 0,
      fixCycleCount: 0,
    });
    const labels = fakeLabels();

    const report = await retireStaleClaim({ store, labels: labels.writer }, { repo, issue: 404, actor: "operator" });

    expect(report.outcome).toBe("holder-is-live");
    expect(report.runId).toBe(runId);
    expect(report.clearedLabels).toEqual([]);
    expect(labels.removed).toEqual([]);
    expect(labels.writer.remove).not.toHaveBeenCalled();
    const after = await store.getRun(runId);
    expect(after.value?.status).toBe("running");
    await store.close();
  });

  it("REFUSES when nothing holds the claim, rather than reporting success", async () => {
    const store = makeStore();
    const labels = fakeLabels();

    const report = await retireStaleClaim({ store, labels: labels.writer }, { repo: "owner/op-c", issue: 404 });

    expect(report.outcome).toBe("no-claim");
    expect(labels.writer.remove).not.toHaveBeenCalled();
    await store.close();
  });

  it("retires the ledger but reports UNRECONCILED when there is no label writer", async () => {
    const store = makeStore();
    const repo = "owner/op-d";
    const runId = await seedParkedRun(store, repo, 404);

    const report = await retireStaleClaim({ store }, { repo, issue: 404 });

    expect(report.outcome).toBe("retired-unreconciled");
    expect(report.runId).toBe(runId);
    expect(report.lines.join(" ")).toMatch(/label/i);
    const after = await store.getRun(runId);
    expect(after.value?.status).toBe("aborted");
    await store.close();
  });

  it("does NOT undo the retirement when the label write fails, and says so", async () => {
    const store = makeStore();
    const repo = "owner/op-e";
    const runId = await seedParkedRun(store, repo, 404);
    const labels = fakeLabels({ failOn: TRIGGER_LABELS.running });

    const report = await retireStaleClaim({ store, labels: labels.writer }, { repo, issue: 404 });

    expect(report.outcome).toBe("retired-unreconciled");
    expect(report.lines.join(" ")).toContain(TRIGGER_LABELS.running);
    const after = await store.getRun(runId);
    expect(after.value?.status).toBe("aborted");
    await store.close();
  });

  it("reports a store that cannot answer as unavailable", async () => {
    const store = new ConsoleRunHistoryStore();

    const report = await retireStaleClaim({ store }, { repo: "owner/op-f", issue: 404 });

    expect(report.outcome).toBe("store-unavailable");
    expect(report.lines.join(" ")).toMatch(/not configured|unavailable/i);
  });
});
