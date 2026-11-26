/**
 * #759 task 6 - GUARD, not a RED, and the distinction is the point.
 *
 * This file began as a RED for "retiring a delivered run should leave a terminal label". The premise was
 * WRONG, and the first run of it measured why:
 *
 *   expected 'no-claim' to be 'retired'
 *
 * A delivered run has already RELEASED its claim, so it cannot be retired at all - the store s own
 * documentation says a `blocked` (parked) holder is retired because a park is a WAIT, and reports
 * `no-claim` when nothing holds the claim. So retiring is never the path that clears a delivered state, and
 * the module s documented rule ("no terminal label is applied - retiring is neither a success nor a
 * failure") was right all along. The labels on WebFeedPOC#260 were lost by the DISPATCH clearing `df:done`,
 * which task 3 fixed and task 3b stopped at the CLI path.
 *
 * Both cases below PASS against the current code. They are here because nothing pinned either fact, and a
 * future change could reintroduce the clearing with nothing to catch it. Reported as a guard, never as a
 * RED: a guard dressed as a RED is a false claim about the code s history.
 *
 * The store is the REAL sqlite store, and the seeding copies the shape from retire-claim-operator.test.ts -
 * a hand-rolled stub behind a cast hides a missing required field behind the cast that silences it.
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

/** The ledger validates an event s status against its TYPE: a park is `blocked`, an outcome is terminal. */
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

describe("retiring never touches a delivered state (#759 task 6)", () => {
  it("retires a PARKED run, clears the in-flight labels, and adds no terminal label", async () => {
    const store = makeStore();
    const repo = "owner/759-parked";
    await seedRunWithStatus(store, repo, 244, "blocked");
    const labels = fakeLabels();

    const report = await retireStaleClaim(
      { store, labels: labels.writer },
      { repo, issue: 244, actor: "operator" },
    );

    expect(report.outcome).toBe("retired");
    expect(report.previousStatus).toBe("blocked");
    expect(labels.removed).toContain(TRIGGER_LABELS.running);
    // The module s documented rule, now pinned rather than merely written down.
    expect(labels.added).toEqual([]);
    expect(report.lines.join("\n")).toMatch(/neither a success nor a failure/);
    await store.close();
  });

  it("cannot retire a DELIVERED run at all - it holds no claim - and touches no label", async () => {
    const store = makeStore();
    const repo = "owner/759-delivered";
    await seedRunWithStatus(store, repo, 260, "succeeded");
    const labels = fakeLabels();

    const report = await retireStaleClaim(
      { store, labels: labels.writer },
      { repo, issue: 260, actor: "operator" },
    );

    // This is the finding that corrected the premise: a delivered run released its claim already, so
    // retirement is not the path that can clear a delivered state.
    expect(report.outcome).toBe("no-claim");
    expect(labels.removed).toEqual([]);
    expect(labels.added).toEqual([]);
    await store.close();
  });
});
