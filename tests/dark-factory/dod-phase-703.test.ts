/**
 * #703 (Leg C): the Definition of Done phase, extracted so a RE-ENTRY can acquire the verdict without the
 * planning and coding phases.
 *
 * Nothing in CI invokes the runner's main flow, so this seam is the only part of leg C the suite can
 * hold. What matters, and what is pinned here, is the routing that makes a verify-only re-entry safe: a
 * phase given an EXISTING pull request must not open a second one, and must read the checks for the pull
 * request the run already recorded.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { runDefinitionOfDonePhase } from "../../scripts/dark-factory-runner";
import { recordRunResumed } from "../../agent/lib/dark-factory/plan-revision-recorder";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const AT = "2026-11-20T09:00:00.000Z";

/** A run parked, then marked resumed - the state a verify-only re-entry starts from. */
async function adoptedRun(store: SqliteRunHistoryStore, repo: string) {
  const accepted = await store.acceptDelivery({
    deliveryId: `delivery-${randomUUID()}`,
    repo,
    issue: 703,
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
  // #702: the ledger refuses a work event from a blocked run, so a re-entry marks it resumed first -
  // exactly as the runner's re-entry branch does.
  const resumed = await recordRunResumed(store, { runId });
  expect(resumed.ok, resumed.error).toBe(true);
  return runId;
}

describe("#703 leg C: a verify-only re-entry runs the DoD alone", () => {
  it("does NOT open a second pull request, and reads the checks for the recorded one", async () => {
    const store = new SqliteRunHistoryStore(":memory:", () => `run-${randomUUID()}`);
    const repo = `owner/verify-${randomUUID().slice(0, 8)}`;
    const runId = await adoptedRun(store, repo);

    const fetched: number[] = [];
    let opened = 0;
    const comments: string[] = [];

    await runDefinitionOfDonePhase(
      {
        runHistory: store,
        labelWriter: {
          add: async () => ({ ok: true }),
          remove: async () => ({ ok: true }),
        },
        prWriter: {
          createPullRequest: async () => {
            opened += 1;
            return {
              ok: true,
              pr: {
                number: 999,
                url: "https://github.com/owner/verify/pull/999",
                head: "feat/x",
                base: "main",
                title: "t",
                body: "b",
              },
            };
          },
        },
        postIssueComment: async (_owner, _repo, _issue, body) => {
          comments.push(body);
          return { ok: true };
        },
        makeCheckFetcher: (prNumber) => {
          fetched.push(prNumber);
          // Null is "the checks could not be read", which the DoD maps to a warning and never to a pass
          // (#659) - deterministic, and it keeps the test off the network.
          return async () => null;
        },
        now: () => 0,
        sleep: async () => {},
        log: () => {},
      },
      {
        runId,
        repo,
        issue: 703,
        head: "feat/dark-factory-703",
        title: "feat: #703 verify only",
        body: "",
        existingPr: {
          number: 243,
          url: `https://github.com/${repo}/pull/243`,
          head: "feat/dark-factory-703",
          base: "main",
          title: "feat: #703 verify only",
          body: "",
        },
      },
    );

    // The whole point: the change is already pushed and already has a pull request, so a re-entry must
    // NOT create another one - and the checks it reads must be THAT pull request's.
    expect(opened).toBe(0);
    expect(fetched).toContain(243);
    expect(fetched).not.toContain(999);
    // The verdict is still reported on the ticket, whichever way it went.
    expect(comments.length).toBeGreaterThanOrEqual(1);
  });
});
