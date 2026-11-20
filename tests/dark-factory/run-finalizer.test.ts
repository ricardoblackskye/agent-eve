/**
 * #284 — terminal lifecycle labels (`df:done` / `df:failed`) on run completion.
 *
 * Acceptance criteria under test:
 * - a successful run applies `df:done` and removes `df:running`
 * - a failed run applies `df:failed` and removes `df:running`
 * - the terminal label is applied at most once per run
 * - a label-write failure is surfaced on the run, not swallowed
 */
import { describe, it, expect } from "vitest";
import {
  applyStartLifecycle,
  applyTerminalLifecycle,
  LabelWriteError,
  type TerminalFinalizerDeps,
} from "../../agent/lib/dark-factory/run-finalizer";
import type { LabelWriter } from "../../agent/lib/dark-factory/definition-of-done";
import type { RunEvent } from "../../agent/lib/dark-factory/run-history";
import type {
  PersistedRunEvent,
  RunHistoryStore,
} from "../../agent/lib/dark-factory/run-history-store";

const AT = "2026-10-10T09:00:00.000Z";
const REPO = "owner/repo";
const RUN_ID = "run-284";

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

function event(partial: Partial<RunEvent> & Pick<RunEvent, "type">): RunEvent {
  return {
    eventId: partial.eventId ?? "evt-other",
    runId: RUN_ID,
    stage: "terminal",
    occurredAt: AT,
    ...partial,
  } as RunEvent;
}

function history(existing: RunEvent[] = []) {
  const appended: RunEvent[] = [];
  const seeded: PersistedRunEvent[] = existing.map((e, index) => ({
    sequence: index + 1,
    event: e,
  }));
  const store = {
    id: "fake",
    async listRunEvents() {
      const all = [
        ...seeded,
        ...appended.map((event, index) => ({
          sequence: seeded.length + index + 1,
          event,
        })),
      ];
      return {
        ok: true,
        mode: "live" as const,
        providerId: "fake",
        value: { items: all },
      };
    },
    async appendEvent(evt: RunEvent) {
      appended.push(evt);
      return { ok: true, mode: "live" as const, providerId: "fake" };
    },
  };
  return { store: store as unknown as RunHistoryStore, appended };
}

function deps(writer: LabelWriter, store: RunHistoryStore): TerminalFinalizerDeps {
  return { labelWriter: writer, runHistory: store };
}

const DOD_DONE = { status: "done" } as unknown as NonNullable<
  Parameters<typeof applyTerminalLifecycle>[1]["dodResult"]
>;
const DOD_REFUSED = { status: "refused" } as unknown as NonNullable<
  Parameters<typeof applyTerminalLifecycle>[1]["dodResult"]
>;
const DOD_BLOCKED = { status: "blocked" } as unknown as NonNullable<
  Parameters<typeof applyTerminalLifecycle>[1]["dodResult"]
>;

describe("#284 terminal lifecycle labels", () => {
  it("a successful run applies df:done and removes df:running", async () => {
    const { writer, calls } = labelWriter();
    const { store, appended } = history();

    const outcome = await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 284,
      runId: RUN_ID,
      terminalStatus: "succeeded",
      dodResult: DOD_DONE,
      occurredAt: AT,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.skipped).toBeFalsy();
    expect(calls).toContain("add:df:done");
    expect(calls).toContain("remove:df:running");
    expect(calls).toContain("remove:needs-answer");
    expect(
      appended.some(
        (e) => e.type === "run.terminal" && e.status === "succeeded",
      ),
    ).toBe(true);
  });

  it("a failed run applies df:failed and removes df:running", async () => {
    const { writer, calls } = labelWriter();
    const { store, appended } = history();

    const outcome = await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 284,
      runId: RUN_ID,
      terminalStatus: "failed",
      occurredAt: AT,
    });

    expect(outcome.applied).toBe(true);
    expect(calls).toContain("add:df:failed");
    expect(calls).toContain("remove:df:running");
    expect(calls).toContain("remove:needs-answer");
    expect(calls).not.toContain("add:df:done");
    expect(
      appended.some((e) => e.type === "run.terminal" && e.status === "failed"),
    ).toBe(true);
  });

  it("withholds df:done when the Definition of Done did not pass", async () => {
    const { writer, calls } = labelWriter();
    const { store } = history();

    const outcome = await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 284,
      runId: RUN_ID,
      terminalStatus: "succeeded",
      dodResult: DOD_REFUSED,
      occurredAt: AT,
    });

    expect(outcome.applied).toBe(true);
    expect(calls).not.toContain("add:df:done");
    expect(calls).toContain("remove:df:running");
  });

  it("withholds df:done when no Definition of Done result is supplied", async () => {
    const { writer, calls } = labelWriter();
    const { store } = history();

    await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 284,
      runId: RUN_ID,
      terminalStatus: "succeeded",
      occurredAt: AT,
    });

    expect(calls).not.toContain("add:df:done");
  });

  it("does NOT skip merely because the DoD recorded its own run.terminal event", async () => {
    // The Definition of Done records `run.terminal` (succeeded) with eventId
    // `dod:<runId>:terminal` BEFORE the finalizer runs. A naive existence check
    // would skip here and df:done would never be applied.
    const { writer, calls } = labelWriter();
    const { store } = history([
      event({
        type: "run.terminal",
        eventId: `dod:${RUN_ID}:terminal`,
        status: "succeeded",
      }),
    ]);

    const outcome = await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 284,
      runId: RUN_ID,
      terminalStatus: "succeeded",
      dodResult: DOD_DONE,
      occurredAt: AT,
    });

    expect(outcome.skipped).toBeFalsy();
    expect(calls).toContain("add:df:done");
  });

  it("applies at most once per run — a re-delivery writes nothing", async () => {
    const { writer, calls } = labelWriter();
    const first = history();

    await applyTerminalLifecycle(deps(writer, first.store), {
      repo: REPO,
      issue: 284,
      runId: RUN_ID,
      terminalStatus: "succeeded",
      dodResult: DOD_DONE,
      occurredAt: AT,
    });
    const marker = first.appended.find((e) => e.type === "run.terminal");
    expect(marker).toBeDefined();

    // Re-deliver against a store that already contains the finalizer's marker.
    const redelivered = history([marker!]);
    const { writer: writer2, calls: calls2 } = labelWriter();
    const outcome = await applyTerminalLifecycle(
      deps(writer2, redelivered.store),
      {
        repo: REPO,
        issue: 284,
        runId: RUN_ID,
        terminalStatus: "succeeded",
        dodResult: DOD_DONE,
        occurredAt: AT,
      },
    );

    expect(outcome.applied).toBe(false);
    expect(outcome.skipped).toBe(true);
    expect(calls2).toHaveLength(0);
    expect(redelivered.appended).toHaveLength(0);
  });

  it("surfaces a label-write failure on the run and throws (fail-closed)", async () => {
    const { writer } = labelWriter((op, label) =>
      op === "add" && label === "df:failed",
    );
    const { store, appended } = history();

    await expect(
      applyTerminalLifecycle(deps(writer, store), {
        repo: REPO,
        issue: 284,
        runId: RUN_ID,
        terminalStatus: "failed",
        occurredAt: AT,
      }),
    ).rejects.toThrow(LabelWriteError);

    // The failure is recorded on the run rather than swallowed...
    expect(appended.length).toBeGreaterThan(0);
    // ...and the failed run is NOT marked as a successfully finalised run.
    expect(
      appended.some((e) => e.eventId === `terminal-lifecycle:${RUN_ID}`),
    ).toBe(false);
  });

  // --- #672: the run outcome vocabulary. The DoD already distinguishes these;
  // the finalizer used to flatten every non-"done" verdict into df:failed. ---

  it("a blocked DoD applies df:blocked and NOT df:failed (#672)", async () => {
    const { writer, calls } = labelWriter();
    const { store, appended } = history();

    const outcome = await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 672,
      runId: RUN_ID,
      // What the runner passed before the fix: the verdict was collapsed to a
      // boolean, so a blocked DoD arrived as "failed".
      terminalStatus: "failed",
      dodResult: DOD_BLOCKED,
      occurredAt: AT,
    });

    // #703: the LABEL still follows the verdict, but the run is deliberately NOT finalised - a blocked
    // verdict leaves it in flight so that it can be resumed. The label half of #672 is what this test
    // pins; the record half has its own #703 test below.
    expect(outcome).toMatchObject({ applied: false, deferred: true });
    expect(calls).toContain("add:df:blocked");
    expect(calls).not.toContain("add:df:failed");
    expect(calls).not.toContain("add:df:done");
    // The in-flight labels still clear: the attempt is over either way.
    expect(calls).toContain("remove:df:running");
    expect(calls).toContain("remove:needs-answer");
    expect(appended.filter((e) => e.type === "run.terminal")).toHaveLength(0);
  });

  it("a refused DoD applies NO terminal label, and is left for review (#271)", async () => {
    const { writer, calls } = labelWriter();
    const { store } = history();

    const outcome = await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 672,
      runId: RUN_ID,
      terminalStatus: "failed",
      dodResult: DOD_REFUSED,
      occurredAt: AT,
    });

    expect(outcome.applied).toBe(true);
    expect(calls).not.toContain("add:df:failed");
    expect(calls).not.toContain("add:df:blocked");
    expect(calls).not.toContain("add:df:done");
    expect(calls).toContain("remove:df:running");
  });

  it("GUARD, not a bug fix: a crash path with no DoD verdict still applies df:failed (#672)", async () => {
    // This passes before the change and must keep passing after it. Without this
    // case, an implementation that labelled EVERY outcome df:blocked would
    // satisfy the two tests above.
    const { writer, calls } = labelWriter();
    const { store } = history();

    await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 672,
      runId: RUN_ID,
      terminalStatus: "failed",
      occurredAt: AT,
    });

    expect(calls).toContain("add:df:failed");
    expect(calls).not.toContain("add:df:blocked");
    expect(calls).not.toContain("add:df:done");
  });

  it("a fresh run clears a previous attempt's df:blocked (#672)", async () => {
    // #672: df:blocked is NOT terminal - a blocked ticket can be re-triggered, which is the whole
    // point of the new outcome. But it IS a previous attempt's verdict, so if it survives into the
    // next attempt the ticket advertises df:running AND df:blocked at once: the contradictory pair
    // #373 removed for df:failed.
    const { writer, calls } = labelWriter();

    const outcome = await applyStartLifecycle(
      { labelWriter: writer },
      { repo: REPO, issue: 672, runId: RUN_ID, occurredAt: AT } as never,
    );

    expect(calls).toContain("remove:df:blocked");
    expect(calls).toContain("remove:df:done");
    expect(calls).toContain("remove:df:failed");
    expect(calls).toContain("add:df:running");
    expect(outcome.cleared).toContain("df:blocked");
  });
});

describe("#698 Leg F — a run that opened a PR must carry it to the terminal record", () => {
  // Measured on WebFeedPOC#235: the run opened and the human merged PR #236, yet the
  // ledger row held pr_url: NULL and the page showed "No PR opened yet". The DoD emits a
  // pr.opened event, but applyTerminalLifecycle finalises the run with its OWN run.terminal
  // event built by terminalEvent(), which dropped prUrl. So the PR never reached the summary
  // the page reads. This leg threads prUrl through that terminal event.
  const DOD_WITH_PR = {
    status: "done",
    pr: { number: 236, url: "https://github.com/ricardoblackskaye/WebFeedPOC/pull/236" },
  } as unknown as NonNullable<
    Parameters<typeof applyTerminalLifecycle>[1]["dodResult"]
  >;

  it("RED: the finalizer's terminal event carries prUrl when the DoD opened a PR", async () => {
    const { writer } = labelWriter();
    const { store, appended } = history();

    await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 235,
      runId: RUN_ID,
      terminalStatus: "succeeded",
      dodResult: DOD_WITH_PR,
      occurredAt: AT,
    });

    const terminal = appended.find((e) => e.type === "run.terminal");
    expect(terminal).toBeDefined();
    // The defect: terminalEvent() built the event without prUrl.
    expect((terminal as RunEvent).prUrl).toBe(
      "https://github.com/ricardoblackskaye/WebFeedPOC/pull/236",
    );
  });

  it("CONTROL: a run with no DoD PR leaves prUrl absent (no inferred link)", async () => {
    const { writer } = labelWriter();
    const { store, appended } = history();

    await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 235,
      runId: RUN_ID,
      terminalStatus: "failed",
      occurredAt: AT,
    });

    const terminal = appended.find((e) => e.type === "run.terminal");
    expect(terminal).toBeDefined();
    expect((terminal as RunEvent).prUrl).toBeUndefined();
  });
});

describe("#703 a run whose DoD is blocked is not finalised", () => {
  // #703: the ticket label already followed the DoD verdict (#672) - it is the terminal EVENT that did
  // not, and that event is also what RELEASES the active-run claim (#373). So a run waiting on its
  // checks was recorded terminal `failed` while its ticket correctly said df:blocked: the record said
  // "finished" and the label said "re-triggerable". `blocked` is deliberately not terminal anywhere in
  // this system (#672: "not done AND resumable"), so a waiting run must be left in exactly that state.
  const dod = (partial: Record<string, unknown>) =>
    partial as unknown as NonNullable<
      Parameters<typeof applyTerminalLifecycle>[1]["dodResult"]
    >;

  it("labels the ticket df:blocked and leaves the run NON-terminal, so its claim survives", async () => {
    const { writer, calls } = labelWriter();
    const { store, appended } = history();

    const outcome = await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 1,
      runId: RUN_ID,
      terminalStatus: "failed",
      dodResult: dod({
        status: "blocked",
        ok: false,
        blockedReason: "checks-not-finished",
        pendingChecks: ["e2e"],
      }),
      occurredAt: AT,
    });

    // The ticket keeps the vocabulary it already had.
    expect(calls).toContain("add:df:blocked");
    expect(calls).toContain("remove:df:running");
    expect(calls).not.toContain("add:df:failed");
    // The RUN is left in flight: no terminal event, so the claim is not released.
    expect(appended.filter((e) => e.type === "run.terminal")).toHaveLength(0);
    expect(outcome).toMatchObject({ applied: false, deferred: true });
  });

  it("records WHY the run is waiting, on the field the page already renders (#703 leg B)", async () => {
    // The parked question already carries its human-facing message on `agentOutputSummary`
    // (worker-reporter.ts), and the AGENT TRACE panel renders any event that carries one - so a waiting
    // run can say what it is waiting for with no new column and no new UI.
    const { writer } = labelWriter();
    const { store, appended } = history();

    await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 1,
      runId: RUN_ID,
      terminalStatus: "failed",
      dodResult: dod({
        status: "blocked",
        ok: false,
        blockedReason: "checks-not-finished",
        pendingChecks: ["e2e", "test"],
        reason: "Review budget exhausted (3 rounds) with 1 unresolved finding(s).",
      }),
      occurredAt: AT,
    });

    const waiting = appended.filter((e) => e.type === "worker.roadblock");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].status).toBe("blocked");
    // The reason names the checks it is waiting for, which is the whole point.
    expect(waiting[0].agentOutputSummary).toContain("e2e");
    expect(waiting[0].agentOutputSummary).toContain("test");
    expect(waiting[0].agentOutputSummary).toContain("checks-not-finished");
  });

  it("still finalises a REFUSED run - that is a real judgement, not a wait", async () => {
    const { writer, calls } = labelWriter();
    const { store, appended } = history();

    const outcome = await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 1,
      runId: RUN_ID,
      terminalStatus: "failed",
      dodResult: dod({ status: "refused", ok: false }),
      occurredAt: AT,
    });

    expect(appended.filter((e) => e.type === "run.terminal")).toHaveLength(1);
    expect(outcome.applied).toBe(true);
    expect(calls).not.toContain("add:df:blocked");
  });

  it("still finalises a DONE run", async () => {
    const { writer, calls } = labelWriter();
    const { store, appended } = history();

    const outcome = await applyTerminalLifecycle(deps(writer, store), {
      repo: REPO,
      issue: 1,
      runId: RUN_ID,
      terminalStatus: "succeeded",
      dodResult: DOD_DONE,
      occurredAt: AT,
    });

    expect(appended.filter((e) => e.type === "run.terminal")).toHaveLength(1);
    expect(outcome.applied).toBe(true);
    expect(calls).toContain("add:df:done");
  });
});
