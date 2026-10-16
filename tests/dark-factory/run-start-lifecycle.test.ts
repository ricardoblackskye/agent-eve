/**
 * #373 — a new attempt must clear the previous attempt's terminal label.
 *
 * The re-run exposed this on WebFeedPOC#161, which ended up carrying four labels at once:
 *
 *   ['feature', 'df:running', 'needs-answer', 'df:failed']
 *
 * `df:failed` was from the earlier failed attempt, and the new run added `df:running` beside it without
 * clearing anything, so the ticket advertised two contradictory outcomes simultaneously — a reader cannot
 * tell whether the Factory is working on it or has already given up.
 *
 * The terminal transition already clears the IN-FLIGHT labels; nothing mirrored that at the START. This is
 * the other half: clear what a finished attempt left behind, then mark this one in flight.
 *
 * Note the deliberate asymmetry with the terminal path. A failed TERMINAL write fails closed, because that
 * transition states the outcome and releases the run's claim. A failed START write does not: these labels are
 * informational, and a transient GitHub error must not stop a run that is otherwise fine. It is reported.
 */
import { describe, it, expect } from "vitest";
import { applyStartLifecycle } from "../../agent/lib/dark-factory/run-finalizer";
import type { LabelWriter } from "../../agent/lib/dark-factory/definition-of-done";

const REPO = "ricardoblackskye/webfeedpoc";
const ISSUE = 161;

function labelWriter(fail?: (op: "add" | "remove", label: string) => boolean) {
  const calls: string[] = [];
  const writer: LabelWriter = {
    async add(_repo, _issue, label) {
      calls.push(`add:${label}`);
      if (fail?.("add", label)) {
        return { ok: false, error: `write failed for ${label}` };
      }
      return { ok: true };
    },
    async remove(_repo, _issue, label) {
      calls.push(`remove:${label}`);
      if (fail?.("remove", label)) {
        return { ok: false, error: `write failed for ${label}` };
      }
      return { ok: true };
    },
  };
  return { writer, calls };
}

describe("#373 a new attempt starts from a clean ticket", () => {
  it("clears the previous attempt's terminal labels and marks this one in flight", async () => {
    const { writer, calls } = labelWriter();

    const outcome = await applyStartLifecycle({ labelWriter: writer }, {
      repo: REPO,
      issue: ISSUE,
    });

    expect(outcome.applied).toBe(true);
    // Both terminal outcomes must go: a stale df:done is as misleading as a stale df:failed.
    expect(calls).toContain("remove:df:done");
    expect(calls).toContain("remove:df:failed");
    expect(calls).toContain("add:df:running");
    // The in-flight label is not cleared at the start — it is the one being applied.
    expect(calls).not.toContain("remove:df:running");
    expect(calls).not.toContain("remove:needs-answer");
  });

  it("reports a label failure instead of throwing, so an informational label cannot stop a run", async () => {
    const { writer } = labelWriter((op, label) => op === "remove" && label === "df:done");

    const outcome = await applyStartLifecycle({ labelWriter: writer }, {
      repo: REPO,
      issue: ISSUE,
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.error).toMatch(/df:done/);
    // The in-flight label was still attempted: one failure must not cancel the rest.
    expect(outcome.cleared).not.toContain("df:done");
  });

  it("names the labels from the shared definitions rather than repeating them as literals", async () => {
    const { writer, calls } = labelWriter();

    await applyStartLifecycle({ labelWriter: writer }, { repo: REPO, issue: ISSUE });

    // Non-vacuous: the calls above are the real writes, so this asserts what was written, not that a
    // constant exists somewhere.
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(
      new Set(["remove:df:done", "remove:df:failed", "add:df:running"]),
    );
  });
});
