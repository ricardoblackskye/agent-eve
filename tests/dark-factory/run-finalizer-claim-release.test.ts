/**
 * #373 — the terminal write must release the active-run claim.
 *
 * The first real UAT run against another repo stopped during planning. It labelled the ticket `df:failed`,
 * posted why, and wrote a `run.terminal` EVENT — and its ledger row still read `queued` hours later:
 *
 *   run_id: 0381b5d8-...  repo: ricardoblackskye/webfeedpoc  issue: 161  status: queued  stage: trigger
 *
 * The claim that refuses a duplicate delivery is held by `status IN ('queued','running','blocked')`, and
 * `applyTerminalLifecycle` only appended an event — it never wrote the summary row that holds that status.
 * So the claim leaked: every later run for the same repo+issue was refused as a duplicate, reporting
 * "the ledger refused the delivery".
 *
 * These cases pin the release, the identity it preserves, and the two things that must NOT change:
 * idempotency, and the tolerance for the partial store doubles other suites drive this with.
 */
import { describe, it, expect } from "vitest";
import {
  applyTerminalLifecycle,
  type TerminalFinalizerDeps,
  type TerminalFinalizeArgs,
} from "../../agent/lib/dark-factory/run-finalizer";
import type { LabelWriter } from "../../agent/lib/dark-factory/definition-of-done";
import type { RunEvent, RunSummary } from "../../agent/lib/dark-factory/run-history";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const AT = "2026-10-16T11:56:01.969Z";
const REPO = "ricardoblackskye/webfeedpoc";
const RUN_ID = "0381b5d8-629b-45b2-970b-362b67a126c9";

/** The claim-holding statuses, named here so the assertion is explicit rather than implied. */
const CLAIM_HOLDING = ["queued", "running", "blocked"];

function okWriter(): LabelWriter {
  return {
    async add() {
      return { ok: true };
    },
    async remove() {
      return { ok: true };
    },
  };
}

/** The row as the UAT run left it: opened at trigger, never moved. */
function leakedRun(): RunSummary {
  return {
    runId: RUN_ID,
    repo: REPO,
    issue: 161,
    status: "queued",
    stage: "trigger",
    createdAt: AT,
    updatedAt: AT,
    attemptCount: 0,
    reviewCount: 0,
    iterationCount: 0,
    fixCycleCount: 0,
  } as unknown as RunSummary;
}

function historyWithSummary(current: RunSummary | undefined) {
  const written: RunSummary[] = [];
  const events: RunEvent[] = [];
  const api = {
    id: "fake",
    async listRunEvents() {
      return {
        ok: true,
        mode: "live",
        providerId: "fake",
        value: {
          items: events.map((event, index) => ({ sequence: index + 1, event })),
        },
      };
    },
    async appendEvent(event: RunEvent) {
      events.push(event);
      return { ok: true, mode: "live", providerId: "fake" };
    },
    async getRun() {
      return current
        ? { ok: true, mode: "live", providerId: "fake", value: current }
        : { ok: false, mode: "blocked", providerId: "fake", error: "no such run" };
    },
    async recordRunSummary(summary: RunSummary) {
      written.push(summary);
      return { ok: true, mode: "live", providerId: "fake", value: summary };
    },
  };
  return {
    deps: { labelWriter: okWriter(), runHistory: api as unknown as RunHistoryStore },
    written,
    events,
  };
}

function args(terminalStatus: "succeeded" | "failed"): TerminalFinalizeArgs {
  return {
    repo: REPO,
    issue: 161,
    runId: RUN_ID,
    terminalStatus,
    occurredAt: AT,
  };
}

describe("#373 the terminal write releases the active-run claim", () => {
  it("moves a failed run's summary off the claim-holding status", async () => {
    const { deps, written } = historyWithSummary(leakedRun());

    const outcome = await applyTerminalLifecycle(deps, args("failed"));

    expect(outcome.applied).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0].status).toBe("failed");
    expect(CLAIM_HOLDING).not.toContain(written[0].status);
  });

  it("marks a successful run 'succeeded', so its claim is released too", async () => {
    const { deps, written } = historyWithSummary(leakedRun());

    await applyTerminalLifecycle(deps, {
      ...args("succeeded"),
      // Required for `succeeded`: `df:done` is applied ONLY when the gate passed (#271).
      dodResult: { status: "done" } as unknown as TerminalFinalizeArgs["dodResult"],
    });

    expect(written).toHaveLength(1);
    expect(written[0].status).toBe("succeeded");
    expect(CLAIM_HOLDING).not.toContain(written[0].status);
  });

  it("rewrites the run's OWN row, keeping its identity", async () => {
    const { deps, written } = historyWithSummary(leakedRun());

    await applyTerminalLifecycle(deps, args("failed"));

    expect(written[0]).toMatchObject({ runId: RUN_ID, repo: REPO, issue: 161 });
  });

  it("does not rewrite the summary a second time — finalising is still at most once", async () => {
    const { deps, written } = historyWithSummary(leakedRun());

    await applyTerminalLifecycle(deps, args("failed"));
    const second = await applyTerminalLifecycle(deps, args("failed"));

    expect(second.skipped).toBe(true);
    expect(written).toHaveLength(1);
  });

  it("does not throw when the store double cannot rewrite a summary", async () => {
    // Other suites drive this with partial doubles that only implement listRunEvents + appendEvent. A run
    // that finished must not be turned into a thrown error by the claim release.
    const partial = {
      id: "partial",
      async listRunEvents() {
        return {
          ok: true,
          mode: "live",
          providerId: "partial",
          value: { items: [] },
        };
      },
      async appendEvent() {
        return { ok: true, mode: "live", providerId: "partial" };
      },
    } as unknown as RunHistoryStore;

    const outcome = await applyTerminalLifecycle(
      { labelWriter: okWriter(), runHistory: partial } as TerminalFinalizerDeps,
      args("failed"),
    );

    expect(outcome.applied).toBe(true);
  });
});
