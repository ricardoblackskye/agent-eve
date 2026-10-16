/**
 * #373 — the terminal EVENT is what releases the active-run claim, and refusing to write it must not be
 * swallowed.
 *
 * CORRECTION of an earlier misdiagnosis, recorded here so it is not retried. I first concluded that
 * `applyTerminalLifecycle` never released the claim because it appends an event and never writes the summary
 * row. That is wrong: `appendEvent` -> `applyRunEvent` derives the updated summary and persists it, so the
 * row's `status` does move to the terminal value and the claim IS released. Verified by reading a real
 * SqliteRunHistoryStore before and after the call.
 *
 * An extra summary write on top of that is not merely redundant, it is HARMFUL: the caller's `occurredAt` is
 * injectable (tests pass a fixed date), so rewriting `updatedAt` from it can move the timestamp BEFORE
 * `createdAt`. The record layer then rejects the row — "Run record requires updatedAt to be at or after
 * createdAt" — and every read of that store fails, not just this row.
 *
 * What the finalizer DOES get wrong is that it ignores the result of that write. Step 3 of the same function
 * collects EVERY result so nothing is swallowed and fails closed on label writes; step 5 checks nothing. A
 * refused terminal event therefore leaves the claim held, silently, and the run looks finished while the
 * ledger still believes it is in flight — the state the real UAT run was left in.
 */
import { describe, it, expect } from "vitest";
import {
  applyTerminalLifecycle,
  type TerminalFinalizeArgs,
} from "../../agent/lib/dark-factory/run-finalizer";
import type { LabelWriter } from "../../agent/lib/dark-factory/definition-of-done";
import type { RunEvent, RunSummary } from "../../agent/lib/dark-factory/run-history";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const AT = "2026-10-16T11:56:01.969Z";
const REPO = "ricardoblackskye/webfeedpoc";
const RUN_ID = "0381b5d8-629b-45b2-970b-362b67a126c9";

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

function args(terminalStatus: "succeeded" | "failed"): TerminalFinalizeArgs {
  return {
    repo: REPO,
    issue: 161,
    runId: RUN_ID,
    terminalStatus,
    occurredAt: AT,
  };
}

function store(options: { eventOk: boolean }) {
  const events: RunEvent[] = [];
  const summaries: RunSummary[] = [];
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
      if (!options.eventOk) {
        return {
          ok: false,
          mode: "blocked",
          providerId: "fake",
          error: "the ledger refused the terminal event write",
        };
      }
      events.push(event);
      return { ok: true, mode: "live", providerId: "fake" };
    },
    async getRun() {
      return {
        ok: true,
        mode: "live",
        providerId: "fake",
        value: { runId: RUN_ID, repo: REPO, issue: 161, status: "queued" },
      };
    },
    async recordRunSummary(summary: RunSummary) {
      summaries.push(summary);
      return { ok: true, mode: "live", providerId: "fake", value: summary };
    },
  };
  return {
    deps: { labelWriter: okWriter(), runHistory: api as unknown as RunHistoryStore },
    events,
    summaries,
  };
}

describe("#373 the terminal write releases the active-run claim", () => {
  it("surfaces a refused terminal-event write — that write is what releases the claim", async () => {
    const { deps } = store({ eventOk: false });

    await expect(applyTerminalLifecycle(deps, args("failed"))).rejects.toThrow(
      /terminal event/i,
    );
  });

  it("still finalises normally when the terminal event IS written", async () => {
    const { deps, events } = store({ eventOk: true });

    const outcome = await applyTerminalLifecycle(deps, args("failed"));

    expect(outcome.applied).toBe(true);
    expect(events.some((event) => event.type === "run.terminal")).toBe(true);
  });

  it("does NOT rewrite the summary itself — that clobbers updatedAt and can make the row unreadable", async () => {
    const { deps, summaries } = store({ eventOk: true });

    await applyTerminalLifecycle(deps, args("failed"));

    expect(summaries).toHaveLength(0);
  });
});