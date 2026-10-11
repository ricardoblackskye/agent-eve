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
});