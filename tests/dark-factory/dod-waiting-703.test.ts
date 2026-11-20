/**
 * #703 (leg B): a run that is WAITING on its checks must RECORD why - and the write has to happen
 * before the transition that blocks the run.
 *
 * This is the test the first attempt did not have. The first version wrote the waiting marker from the
 * finalizer, which runs AFTER the DoD has already blocked the run - and the ledger permits only
 * `run.resumed` or `run.terminal` out of `blocked`, so the write was REFUSED on a live run
 * (WebFeedPOC#244) while a stubbed store, which accepted anything, kept the suite green.
 *
 * So this test uses the REAL store: the transition rule lives there, and only the real store can say no.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CHECKS_NOT_FINISHED,
  isWaitingOnChecks,
  runDefinitionOfDone,
  WAITING_EVENT_PREFIX,
  type DefinitionOfDoneDeps,
  type DefinitionOfDoneTask,
  type PrOpener,
} from "../../agent/lib/dark-factory/definition-of-done";
import { recordRunResumed } from "../../agent/lib/dark-factory/plan-revision-recorder";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const AT = "2026-11-20T10:00:00.000Z";

const PR: PrOpener = {
  createPullRequest: async () => ({
    ok: true,
    pr: {
      number: 245,
      url: "https://github.com/owner/repo/pull/245",
      head: "feat/dark-factory-244",
      base: "main",
      title: "feat: #244",
      body: "",
    },
  }),
};

/** A run that is RUNNING - the state a DoD review loop starts from. */
async function runningRun(store: SqliteRunHistoryStore, repo: string) {
  const accepted = await store.acceptDelivery({
    deliveryId: `delivery-${randomUUID()}`,
    repo,
    issue: 244,
    receivedAt: AT,
  });
  const runId = accepted.value?.runId ?? "";
  expect(runId).not.toBe("");
  await store.appendEvent({
    eventId: `park:${runId}`,
    runId,
    type: "worker.question",
    stage: "worker",
    occurredAt: AT,
    status: "blocked",
  });
  const resumed = await recordRunResumed(store, { runId });
  expect(resumed.ok, resumed.error).toBe(true);
  return runId;
}

describe("#703 leg B: a waiting run records why, BEFORE it blocks", () => {
  it("records the pending check, and the blocked round still lands after it", async () => {
    const store = new SqliteRunHistoryStore(":memory:", () => `run-${randomUUID()}`);
    const repo = `owner/waiting-${randomUUID().slice(0, 8)}`;
    const runId = await runningRun(store, repo);

    const task: DefinitionOfDoneTask = {
      runId,
      repo,
      issue: 244,
      head: "feat/dark-factory-244",
      base: "main",
      title: "feat: #244",
      body: "",
    };

    const deps: DefinitionOfDoneDeps = {
      prWriter: PR,
      commentWriter: { postComment: async () => ({ ok: true }) },
      // The repository's own check has NOT finished: the whole of the obstacle is an unsettled check, so
      // this verdict is a WAIT (not a real judgment).
      runChecks: async () => [
        {
          id: "PR-CHECK-UNSETTLED:e2e",
          source: "linter" as const,
          severity: "error" as const,
          message: "The check 'e2e' has not finished (in_progress).",
        },
      ],
      // Deliberately the PRODUCTION shape: no attemptFixes (#718), no testResults.
      runHistory: store,
      env: { DF_MAX_REVIEW_ROUNDS: "1" },
    };

    const result = await runDefinitionOfDone(deps, task);
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(CHECKS_NOT_FINISHED);
    expect(result.pendingChecks).toEqual(["e2e"]);

    const listed = await store.listRunEvents(runId);
    const events = (listed.value?.items ?? []).map(({ event, sequence }) => ({ event, sequence }));

    // The reason is recorded, it names the check, and it is keyed on the marker a resume routes on.
    const waiting = events.find((e) => e.event.type === "worker.roadblock");
    expect(waiting, "the waiting marker must be recorded").toBeDefined();
    expect(waiting!.event.eventId.startsWith(WAITING_EVENT_PREFIX)).toBe(true);
    expect(waiting!.event.agentOutputSummary).toContain("e2e");
    expect(isWaitingOnChecks(events.map((e) => e.event))).toBe(true);

    // THE ORDER MATTERS: the marker precedes the blocked round. Written the other way round the store
    // refuses it, which is exactly what happened on the live run.
    const blockedRound = events.find(
      (e) => e.event.type === "review.round" && e.event.status === "blocked",
    );
    expect(blockedRound, "the blocked round must still land").toBeDefined();
    expect(waiting!.sequence).toBeLessThan(blockedRound!.sequence);

    // And the run is left non-terminal: no terminal event, so the claim survives.
    expect(events.some((e) => e.event.type === "run.terminal")).toBe(false);
    const summary = await store.getRun(runId);
    expect(summary.value?.status).toBe("blocked");
    expect(summary.value?.completedAt).toBeUndefined();
  });
});
