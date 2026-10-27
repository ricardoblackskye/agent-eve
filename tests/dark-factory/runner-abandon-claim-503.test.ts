/**
 * #503 AC5 — an abort that escapes `main` must still release the run's claim.
 *
 * `main` has no outer try: the entry-point catch only logged the error and closed the control store, so a
 * throw AFTER the run was accepted (the STEP 5 render crash included) left the issue on `df:running` and
 * the ledger holding a claim no later attempt could adopt — which is why two runs in a row needed manual
 * retirement before they could re-run.
 *
 * `applyTerminalLifecycle` is what releases the claim (its terminal event IS the release) and it is
 * idempotent, so a run already finalised by a phase-level catch is not double-labelled. `main` cannot be
 * called, so these tests drive the extracted helper over the REAL `applyTerminalLifecycle`, a recording
 * label writer and a fake ledger.
 */
import { describe, expect, it } from "vitest";
import { releaseAbandonedRunClaim } from "../../scripts/dark-factory-runner";
import type { LabelWriter } from "../../agent/lib/dark-factory/definition-of-done";
import type { RunEvent, RunSummary } from "../../agent/lib/dark-factory/run-history";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const REPO = "ricardoblackskye/webfeedpoc";
const RUN_ID = "9b21474d-6d5d-490a-9c1a-503000000000";

function recordingLabels(ok = true) {
  const ops: string[] = [];
  const labelWriter: LabelWriter = {
    add: async (_repo, _issue, label) => {
      ops.push(`+${label}`);
      return ok ? { ok: true } : { ok: false, error: "labels API unavailable" };
    },
    remove: async (_repo, _issue, label) => {
      ops.push(`-${label}`);
      return ok ? { ok: true } : { ok: false, error: "labels API unavailable" };
    },
  };
  return { labelWriter, ops };
}

/** A fake ledger shaped like `RunHistoryStore` for the calls the finalizer makes. */
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
        value: { runId: RUN_ID, repo: REPO, issue: 173, status: "queued" },
      };
    },
    async recordRunSummary(summary: RunSummary) {
      return { ok: true, mode: "live", providerId: "fake", value: summary };
    },
  };
  return { runHistory: api as unknown as RunHistoryStore, events };
}

describe("#503 AC5 an abort after acceptance releases the claim", () => {
  it("writes the terminal lifecycle (label + terminal event) for an active run", async () => {
    const { labelWriter, ops } = recordingLabels();
    const { runHistory, events } = fakeHistory();

    await releaseAbandonedRunClaim({
      repo: REPO,
      issue: 173,
      runId: RUN_ID,
      runHistory,
      labelWriter,
    });

    // The terminal event is what releases the claim; the label is the human-facing half.
    expect(events.some((event) => event.type === "run.terminal")).toBe(true);
    expect(ops).toContain("+df:failed");
  });

  it("is a no-op when there is no active run", async () => {
    await expect(releaseAbandonedRunClaim(null)).resolves.toBeUndefined();
  });

  it("is a no-op when the run was accepted but the label writer was never attached", async () => {
    const { runHistory, events } = fakeHistory();
    await expect(
      releaseAbandonedRunClaim({ repo: REPO, issue: 173, runId: RUN_ID, runHistory }),
    ).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it("does not mask the original abort when the release itself fails", async () => {
    const { labelWriter } = recordingLabels(false);
    const { runHistory } = fakeHistory();

    // A label write refused -> applyTerminalLifecycle throws -> the helper must swallow it and still
    // exit cleanly, so the failure that caused the abort is the one the operator sees.
    await expect(
      releaseAbandonedRunClaim({
        repo: REPO,
        issue: 173,
        runId: RUN_ID,
        runHistory,
        labelWriter,
      }),
    ).resolves.toBeUndefined();
  });
});
