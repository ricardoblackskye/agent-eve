/**
 * #373 — a refusal to write the terminal event is not always a failure to release the claim.
 *
 * The UAT surfaced this. When the circuit breaker trips it writes its OWN `run.terminal` event
 * (`breaker-trip:…`), which moves the run to a terminal status — so the claim IS released. The runner then
 * finalises through the ordinary path, the store correctly refuses to append a second terminal event:
 *
 *   Run record requires "runId" to reference a non-terminal run (received "492c038b-…")
 *
 * and the guard added earlier this round threw, reporting "so this run's claim was not released" — the exact
 * opposite of the truth, on a run whose claim was already free.
 *
 * So the guard must distinguish two refusals that look identical at the call site:
 *
 *   - the run is ALREADY terminal → the claim is released; the duplicate event must simply not be written,
 *     and this is idempotent success, not an error;
 *   - the run is NOT terminal and the event was refused → the claim really is still held, and that must stay
 *     loud.
 *
 * The label work runs before the event, so a run that was already terminated elsewhere still gets its
 * terminal label applied and its in-flight labels cleared — asserted here, because silently skipping that
 * would leave a finished run still advertised as `df:running` on the ticket.
 */
import { describe, it, expect } from "vitest";
import {
  applyTerminalLifecycle,
  type TerminalFinalizeArgs,
} from "../../agent/lib/dark-factory/run-finalizer";
import type { LabelWriter } from "../../agent/lib/dark-factory/definition-of-done";
import type { RunEvent, RunSummary } from "../../agent/lib/dark-factory/run-history";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const AT = "2026-10-16T15:09:46.469Z";
const REPO = "ricardoblackskye/webfeedpoc";
const RUN_ID = "492c038b-624c-4ce5-ad0a-0edaa77750fc";

const REFUSAL =
  'Run record requires "runId" to reference a non-terminal run (received "492c038b-…")';

function store(options: { status: string }) {
  const labelOps: string[] = [];
  const labels: LabelWriter = {
    async add(_repo, _issue, label) {
      labelOps.push(`+${label}`);
      return { ok: true };
    },
    async remove(_repo, _issue, label) {
      labelOps.push(`-${label}`);
      return { ok: true };
    },
  };
  const api = {
    id: "fake",
    async listRunEvents() {
      return { ok: true, mode: "live", providerId: "fake", value: { items: [] } };
    },
    async appendEvent(_event: RunEvent) {
      return { ok: false, mode: "blocked", providerId: "fake", error: REFUSAL };
    },
    async getRun() {
      return {
        ok: true,
        mode: "live",
        providerId: "fake",
        value: { runId: RUN_ID, repo: REPO, issue: 163, status: options.status } as RunSummary,
      };
    },
  };
  return {
    deps: { labelWriter: labels, runHistory: api as unknown as RunHistoryStore },
    labelOps,
  };
}

function args(): TerminalFinalizeArgs {
  return { repo: REPO, issue: 163, runId: RUN_ID, terminalStatus: "failed", occurredAt: AT };
}

describe("#373 a refusal on an already-terminal run", () => {
  it("is treated as released, not as an error", async () => {
    const { deps } = store({ status: "failed" });

    const outcome = await applyTerminalLifecycle(deps, args());

    expect(outcome.applied).toBe(true);
  });

  it("still applies the terminal label, so the ticket cannot stay advertised as in-flight", async () => {
    const { deps, labelOps } = store({ status: "failed" });

    await applyTerminalLifecycle(deps, args());

    expect(labelOps).toContain("+df:failed");
    expect(labelOps).toContain("-df:running");
  });

  it("STILL fails loudly when the run is not terminal and the event was refused", async () => {
    const { deps } = store({ status: "running" });

    await expect(applyTerminalLifecycle(deps, args())).rejects.toThrow(/not released/);
  });
});
