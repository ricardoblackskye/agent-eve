import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildAttemptSummary } from "../../agent/lib/dark-factory/run-attempt-summary";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

/**
 * #681 - a run the LEDGER never minted must still be visible in the run history.
 *
 * `beginRunRecord` can return without a ledger run: the store may be unreachable, in which case it
 * logs "[WARN] The run record could not be opened (...); this run will not be recorded" and reports
 * `fellBack: true` with the ATTEMPT id as the run id. The runner then carries on and does real work -
 * cloning, planning, coding, opening a pull request - and every one of those writes targets a run the
 * ledger has never heard of.
 *
 * The result is a run that happened and that nothing reading the history can see: not the listing, not
 * the status counts, and not "how many attempts has this ticket had", which is the visibility ADR 0086
 * assumes. This builder makes such a run recordable.
 *
 * The status is deliberately TERMINAL. `df_run_active_issue_uidx` is a partial unique index over
 * `(repo, issue) WHERE status IN ('queued','running','blocked')`, so writing a non-terminal row for an
 * issue that already has one is a claim violation. A run that reached an outcome is finished, and that
 * is what is being recorded.
 */
const at = "2026-11-18T10:00:00.000Z";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a sqlite file briefly; a temp dir is not worth failing on.
    }
  }
});

const BASE = {
  runId: "run-fallback-1",
  repo: "ricardoblackskye/webfeedpoc",
  issue: 681,
  status: "succeeded" as const,
  createdAt: "2026-11-18T10:00:00.000Z",
  completedAt: "2026-11-18T10:05:00.000Z",
};

describe("#681 the summary for a run the ledger never minted", () => {
  it("carries the identity the caller gave it, not a synthesized one", () => {
    const summary = buildAttemptSummary(BASE);
    expect(summary.runId).toBe("run-fallback-1");
    expect(summary.repo).toBe("ricardoblackskye/webfeedpoc");
    expect(summary.issue).toBe(681);
    expect(summary.status).toBe("succeeded");
  });

  it("is TERMINAL, so it cannot collide with the active-run claim", () => {
    // The index allows ONE row per (repo, issue) with a non-terminal status. This row must never be
    // a second one: it describes a run that has finished, and the claim belongs to a live attempt.
    const summary = buildAttemptSummary({ ...BASE, status: "aborted" });
    expect(["queued", "running", "blocked"]).not.toContain(summary.status);
    expect(summary.stage).toBe("terminal");
    expect(summary.completedAt).toBe("2026-11-18T10:05:00.000Z");
  });

  it("fills the counts the type requires rather than leaving them undefined", () => {
    const summary = buildAttemptSummary(BASE);
    expect(summary.attemptCount).toBe(1);
    expect(summary.reviewCount).toBe(0);
    expect(summary.iterationCount).toBe(0);
    expect(summary.fixCycleCount).toBe(0);
  });

  it("carries through what the run actually knows, and omits what it does not", () => {
    const summary = buildAttemptSummary({
      ...BASE,
      startedAt: "2026-11-18T10:00:30.000Z",
      iterationCount: 2,
      prUrl: "https://github.com/ricardoblackskye/WebFeedPOC/pull/231",
    });
    expect(summary.startedAt).toBe("2026-11-18T10:00:30.000Z");
    expect(summary.iterationCount).toBe(2);
    expect(summary.prUrl).toBe("https://github.com/ricardoblackskye/WebFeedPOC/pull/231");
    // Never invented: a summary with a fabricated field reads as complete and is worse than a gap.
    expect(summary.latencyMs).toBeUndefined();
    expect(summary.costUsd).toBeUndefined();
    expect(summary.gitDiff).toBeUndefined();
  });

  it("uses completedAt as the update time, falling back to createdAt", () => {
    expect(buildAttemptSummary(BASE).updatedAt).toBe("2026-11-18T10:05:00.000Z");
    const { completedAt: _drop, ...open } = BASE;
    expect(buildAttemptSummary(open).updatedAt).toBe("2026-11-18T10:00:00.000Z");
  });
});

/**
 * The claim itself is the risk here, so it is asserted rather than reasoned about.
 *
 * `df_run_active_issue_uidx` is UNIQUE over `(repo, issue) WHERE status IN
 * ('queued','running','blocked')`. The attempt row is TERMINAL and therefore outside that partial
 * index, which is what lets it be written for an issue whose claim is already held. If it were ever
 * written non-terminal, this suite would fail on the real store rather than in production.
 */
describe("#681 the attempt row coexists with a live claim", () => {
  it("writes a terminal row for an issue that ALREADY holds an active run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "df-attempt-"));
    dirs.push(dir);
    const store = new SqliteRunHistoryStore(join(dir, "runs.db"), () => `run-${randomUUID()}`);
    const repo = `owner/attempt-${randomUUID().slice(0, 8)}`;

    const accepted = await store.acceptDelivery({
      deliveryId: `attempt-${randomUUID()}`,
      repo,
      issue: 681,
      receivedAt: at,
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.value?.status).toBeDefined();

    // A second run for the same issue: TERMINAL, so it cannot collide with that claim.
    const written = await store.recordRunSummary(
      buildAttemptSummary({
        runId: `attempt-${randomUUID().slice(0, 8)}`,
        repo,
        issue: 681,
        status: "succeeded",
        createdAt: at,
        completedAt: at,
      }),
    );
    expect(written.ok).toBe(true);

    const listed = await store.listRuns({ repo });
    expect(listed.ok).toBe(true);
    const runs = listed.value?.items ?? [];
    // Two rows for one issue: the ledger's run, and the attempt that had to record itself.
    expect(runs.length).toBe(2);
    expect(runs.map((run) => run.status).sort()).toEqual(["queued", "succeeded"]);
  });
});

