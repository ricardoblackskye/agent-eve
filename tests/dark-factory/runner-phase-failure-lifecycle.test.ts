/**
 * #376 — a failure AFTER the run is accepted must END the run.
 *
 * The terminal lifecycle is what releases the run's claim, so a failure that skips it leaves the
 * ticket on `df:running` and the ledger holding a claim no later attempt may adopt. Observed for
 * real: the first sandbox-backed push died on TLS certificate verification, `main`'s catch only
 * logged, and #165 was left in exactly that state.
 *
 * The lifecycle is applied inside `main`'s coding-phase catch, which no test can call. These tests
 * drive the extracted helper instead — real `applyTerminalLifecycle` over a recording label writer
 * and a fake ledger, so the assertion is about the run's terminal state rather than a mock call.
 */
import { describe, expect, it } from "vitest";
import { CircuitTrippedError } from "../../agent/lib/dark-factory/developer-agent";
import { finalizeCodingPhaseFailure } from "../../scripts/dark-factory-runner";
import type { LabelWriter } from "../../agent/lib/dark-factory/definition-of-done";
import type { RunEvent, RunSummary } from "../../agent/lib/dark-factory/run-history";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const REPO = "ricardoblackskye/webfeedpoc";
const RUN_ID = "6f44d0c9-699e-4d0c-9d1a-376000000000";
const TARGET = { repo: REPO, issue: 165, runId: RUN_ID };

function recordingLabels() {
  const ops: string[] = [];
  const labelWriter: LabelWriter = {
    add: async (_repo, _issue, label) => {
      ops.push(`+${label}`);
      return { ok: true };
    },
    remove: async (_repo, _issue, label) => {
      ops.push(`-${label}`);
      return { ok: true };
    },
  };
  return { labelWriter, ops };
}

/** A fake ledger shaped like `RunHistoryStore` for the two calls the finalizer makes. */
function fakeHistory() {
  const events: RunEvent[] = [];
  const api = {
    id: "fake",
    async listRunEvents() {
      return {
        ok: true,
        mode: "live",
        providerId: "fake",
        value: { items: events.map((event, i) => ({ sequence: i + 1, event })) },
      };
    },
    async appendEvent(event: RunEvent) {
      events.push(event);
      return { ok: true, mode: "live", providerId: "fake" };
    },
    async getRun() {
      return {
        ok: true,
        mode: "live",
        providerId: "fake",
        value: { runId: RUN_ID, repo: REPO, issue: 165, status: "queued" },
      };
    },
    async recordRunSummary(summary: RunSummary) {
      return { ok: true, mode: "live", providerId: "fake", value: summary };
    },
  };
  return { runHistory: api as unknown as RunHistoryStore, events };
}

const noTrips = { getTripEvents: () => [] };

describe("#376 a failed coding phase ends the run", () => {
  it("applies the terminal lifecycle for a NON-trip failure", async () => {
    const { labelWriter, ops } = recordingLabels();
    const { runHistory, events } = fakeHistory();

    await finalizeCodingPhaseFailure(
      { labelWriter, runHistory, breaker: noTrips },
      TARGET,
      // The real failure: the vault-path push could not verify TLS.
      new Error("sandbox push failed: git push failed (exit 128)"),
    );

    // The ticket is labelled, and the terminal event is what releases the claim.
    expect(ops).toContain("+df:failed");
    expect(events.some((event) => event.type === "run.terminal")).toBe(true);
  });

  it("still records the breaker trips when the failure IS a trip", async () => {
    const { labelWriter, ops } = recordingLabels();
    const { runHistory, events } = fakeHistory();

    await finalizeCodingPhaseFailure(
      {
        labelWriter,
        runHistory,
        breaker: {
          getTripEvents: () => [
            {
              pbiId: "pbi-165",
              timestamp: "2026-10-16T18:25:00.000Z",
              reason: "failed-selfcorrect-exceeded",
              limit: 3,
              workerMinutes: 4,
            },
          ],
        },
      },
      TARGET,
      new CircuitTrippedError("the coding loop tripped"),
    );

    expect(ops).toContain("+df:failed");
    // Two writes: the trip, explainable on the run, then the terminal event.
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(events)).toContain("selfcorrect");
  });
});
