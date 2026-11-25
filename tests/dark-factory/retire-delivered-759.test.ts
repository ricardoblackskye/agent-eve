/**
 * #759 task 6 - retiring a DELIVERED run.
 *
 * `retire-claim.ts` states its own rule: "No terminal label is applied - retiring is neither a success
 * nor a failure." That rule is RIGHT for a run that never delivered, and this file keeps it there (the
 * second case is the control). It is wrong for one that DID deliver: retiring then clears the in-flight
 * labels and leaves the ticket advertising nothing at all, so a finished issue becomes indistinguishable
 * from one nobody has touched - observed on WebFeedPOC#260, whose labels ended as "In progress" alone.
 *
 * The report already carries `previousStatus`, so the two cases are distinguishable without new state.
 *
 * The store is the REAL sqlite store and the seeding copies the shape from retire-claim-operator.test.ts,
 * because a hand-rolled stub with a cast hides a missing required field behind the cast that silences it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { retireStaleClaim } from "../../agent/lib/dark-factory/retire-claim";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { TRIGGER_LABELS } from "../../agent/lib/dark-factory/trigger";
import type { LabelWriter } from "../../agent/lib/dark-factory/definition-of-done";

const at = "2026-11-25T12:00:00.000Z";
const dirs: string[] = [];

function makeStore(): SqliteRunHistoryStore {
  const dir = mkdtempSync(join(tmpdir(), "df-retire-759-"));
  dirs.push(dir);
  let n = 0;
  return new SqliteRunHistoryStore(join(dir, "runs.db"), () => `run-759-${++n}`);
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

/** The twin of seedParkedRun, differing only in the verdict the ledger carries. */
async function seedRunWithStatus(
  store: SqliteRunHistoryStore,
  repo: string,
  issue: number,
  status: "blocked" | "succeeded",
) {
  const accepted = await store.acceptDelivery({
    deliveryId: `d-${repo}-${issue}`,
    repo,
    issue,
    receivedAt: at,
  });
  const runId = accepted.value?.runId as string;
  // The ledger validates an event s status against its TYPE, so the two cases need different types:
  // `worker.question` is only ever `blocked`, while an outcome rides on `run.terminal`. Seeding a
  // succeeded run as a worker.question is REFUSED by the store - which is how the first attempt at
  // this fixture failed for a setup reason instead of measuring the defect.
  await store.appendEvent(
    status === "blocked"
      ? {
          eventId: `q-${runId}`,
          runId,
          type: "worker.question",
          stage: "worker",
          occurredAt: at,
          status,
        }
      : {
          eventId: `t-${runId}`,
          runId,
          type: "run.terminal",
          stage: "terminal",
          occurredAt: at,
          status,
        },
  );
  return runId;
}

describe("retiring a DELIVERED run (#759)", () => {
  it("keeps the delivered state, so the ticket still reads as delivered", async () => {
    const store = makeStore();
    const repo = "owner/759-a";
    await seedRunWithStatus(store, repo, 260, "succeeded");
    const labels = fakeLabels();

    const report = await retireStaleClaim(
      { store, labels: labels.writer },
      { repo, issue: 260, actor: "operator" },
    );

    expect(report.outcome).toBe("retired");
    expect(report.previousStatus).toBe("succeeded");
    // The in-flight labels still go - a retired run is not live.
    expect(labels.removed).toContain(TRIGGER_LABELS.running);
    // And the delivered state is restored, so the ticket is not left unlabelled.
    expect(labels.added).toContain(TRIGGER_LABELS.done);
    expect(report.lines.join("\n")).toMatch(/delivered/i);
    await store.close();
  });

  // The control: the module's own documented rule still holds for a run that never delivered.
  it("still applies no terminal label when the retired run did not deliver", async () => {
    const store = makeStore();
    const repo = "owner/759-b";
    await seedRunWithStatus(store, repo, 244, "blocked");
    const labels = fakeLabels();

    const report = await retireStaleClaim(
      { store, labels: labels.writer },
      { repo, issue: 244, actor: "operator" },
    );

    expect(report.outcome).toBe("retired");
    expect(report.previousStatus).toBe("blocked");
    expect(labels.added).toEqual([]);
    expect(report.lines.join("\n")).toMatch(/neither a success nor a failure/);
    await store.close();
  });
});
