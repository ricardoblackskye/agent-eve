import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  attemptRecordingDecision,
  buildAttemptSummary,
} from "../../agent/lib/dark-factory/run-attempt-summary";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { recordRunAttemptSummary } from "../../scripts/dark-factory-runner";

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

/**
 * #681 - a run the ledger never minted is recorded, but only where recording can mean something.
 *
 * `ledgerRecorded` alone is not enough, and this is the gap the investigation exposed. A
 * ConsoleRunHistoryStore reports `recorded: true` for every write while persisting nothing, so a run
 * whose store is the console would record itself into a void and report success. The store's own id is
 * the honest signal: writing to a console store is theatre, and the operator needs to hear that the run
 * will not be persisted rather than receive a silent no-op.
 */
describe("#681 when a run must record itself", () => {
  it("records when the ledger minted nothing, and the store can persist", () => {
    expect(attemptRecordingDecision({ storeId: "postgres", ledgerRecorded: false }))
      .toEqual({ record: true });
  });

  it("does NOT record when the ledger already minted the run", () => {
    expect(attemptRecordingDecision({ storeId: "postgres", ledgerRecorded: true }))
      .toEqual({ record: false });
  });

  it("FAILS CLOSED when the caller has not said whether the ledger recorded", () => {
    // An omitted flag is not a claim that a run is missing; guessing writes a second row for a live issue.
    expect(attemptRecordingDecision({ storeId: "postgres" })).toEqual({ record: false });
  });

  it("does NOT pretend to record against a store that cannot persist, and says why", () => {
    // The console store accepts every write and keeps none: reporting success there is the same class
    // of defect as an empty matrix reading as a clean result.
    const decision = attemptRecordingDecision({ storeId: "console", ledgerRecorded: false });
    expect(decision.record).toBe(false);
    expect(decision.reason).toContain("console");
  });
});

/**
 * #698 - the terminal facts must reach a run the ledger DID mint.
 *
 * The real run e626dc1e (WebFeedPOC#200) succeeded and opened PR #201, and its row still read
 * `started_at = NULL`, `attempt_count = 0`, `pr_url = NULL` - because `recordRunAttemptSummary` is the
 * #681 FALLBACK and a no-op when the ledger minted the run. So the one run that most needs its terminal
 * update is exactly the one that never gets it, and the page renders dashes and zeros for a run that
 * did real work.
 */
describe("#698 a run the ledger minted still gets its terminal facts", () => {
  it("updates the minted row in place, and does not mint a second one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "df-minted-"));
    dirs.push(dir);
    const store = new SqliteRunHistoryStore(join(dir, "runs.db"), () => `run-${randomUUID()}`);
    const repo = `owner/minted-${randomUUID().slice(0, 8)}`;
    // A sane chronology: the store refuses a record whose completedAt precedes its updatedAt, which is
    // exactly what a fixture mixing the delivery date with the run's date produces.
    const deliveredAt = "2026-11-13T16:00:00.000Z";

    const accepted = await store.acceptDelivery({
      deliveryId: `minted-${randomUUID()}`,
      repo,
      issue: 698,
      receivedAt: deliveredAt,
    });
    expect(accepted.ok).toBe(true);
    const runId = accepted.value?.runId ?? "";
    expect(runId).not.toBe("");

    await recordRunAttemptSummary(
      {
        runId,
        repo,
        issue: 698,
        startedAt: "2026-11-13T16:16:03.000Z",
        runHistory: store,
        ledgerRecorded: true,
      } as never,
      {
        status: "succeeded",
        completedAt: "2026-11-13T17:10:14.000Z",
        iterationCount: 2,
        prUrl: "https://github.com/ricardoblackskye/WebFeedPOC/pull/201",
      },
    );

    const read = await store.getRun(runId);
    expect(read.ok).toBe(true);
    expect(read.value?.startedAt).toBe("2026-11-13T16:16:03.000Z");
    expect(read.value?.completedAt).toBe("2026-11-13T17:10:14.000Z");
    expect(read.value?.iterationCount).toBe(2);
    expect(read.value?.prUrl).toBe("https://github.com/ricardoblackskye/WebFeedPOC/pull/201");

    // CONTROL: the claim is untouched - still ONE row for this issue, and it is terminal.
    const listed = await store.listRuns({ repo });
    expect(listed.value?.items.length).toBe(1);
  });

  it("CONTROL: still records a run the ledger never minted (#681 unchanged)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "df-no-ledger-"));
    dirs.push(dir);
    const store = new SqliteRunHistoryStore(join(dir, "runs.db"), () => `run-${randomUUID()}`);
    const repo = `owner/no-ledger-${randomUUID().slice(0, 8)}`;

    await recordRunAttemptSummary(
      {
        runId: `attempt-${randomUUID().slice(0, 8)}`,
        repo,
        issue: 681,
        startedAt: at,
        runHistory: store,
        ledgerRecorded: false,
      } as never,
      { status: "succeeded", completedAt: at },
    );

    const listed = await store.listRuns({ repo });
    expect(listed.value?.items.length).toBe(1);
  });
});

describe("#699 a parked minted run stays resumable after the normal exit", () => {
  it("keeps a parked minted run blocked and resumable after the normal-exit summary write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "df-parked-minted-"));
    dirs.push(dir);
    const store = new SqliteRunHistoryStore(join(dir, "runs.db"), () => `run-${randomUUID()}`);
    const repo = `owner/parked-${randomUUID().slice(0, 8)}`;
    const deliveredAt = "2026-11-19T13:30:00.000Z";

    const accepted = await store.acceptDelivery({
      deliveryId: `parked-${randomUUID()}`,
      repo,
      issue: 234,
      receivedAt: deliveredAt,
    });
    expect(accepted.ok).toBe(true);
    const runId = accepted.value?.runId ?? "";
    expect(runId).not.toBe("");

    const parked = await store.appendEvent({
      eventId: `park:${runId}`,
      runId,
      type: "worker.question",
      stage: "worker",
      occurredAt: "2026-11-19T13:34:00.000Z",
      status: "blocked",
    });
    expect(parked.ok).toBe(true);
    expect(parked.value?.status).toBe("blocked");

    // This is the normal-exit write after main() returns from parkForApproval().
    await recordRunAttemptSummary(
      {
        runId,
        repo,
        issue: 234,
        startedAt: "2026-11-19T13:30:00.000Z",
        runHistory: store,
        ledgerRecorded: true,
      } as never,
      { status: "succeeded", completedAt: "2026-11-19T13:34:01.000Z" },
    );

    const read = await store.getRun(runId);
    expect(read.ok).toBe(true);
    expect(read.value?.status).toBe("blocked");
    expect(read.value?.stage).toBe("worker");
    expect(read.value?.completedAt).toBeUndefined();

    // A later delivery can adopt the same blocked claim; it must not create a new run.
    const resumed = await store.acceptDelivery({
      deliveryId: `approval-${randomUUID()}`,
      repo,
      issue: 234,
      receivedAt: "2026-11-19T13:35:00.000Z",
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.activeConflict?.runId).toBe(runId);
    expect(resumed.value).toBeUndefined();
  });
});
