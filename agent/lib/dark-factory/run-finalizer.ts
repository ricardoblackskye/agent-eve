/**
 * #284 — terminal lifecycle labels (`df:done` / `df:failed`) at run completion.
 *
 * A finished Dark Factory run must carry a terminal lifecycle label so it is
 * distinguishable from an abandoned one on the ticket, and so the trigger re-run
 * guard (`decideDarkFactoryTrigger`) has something to key on in production.
 * Applying the label inline in the runner left every failure path unlabelled and
 * `df:failed` written nowhere.
 *
 * This module is the single, testable seam the runner (and later the orchestrator)
 * calls at run completion. It is:
 *
 * - **idempotent** — a re-delivery applies nothing (a run is finalised at most once);
 * - **fail-closed** — a label-write failure is recorded on the run AND thrown, never
 *   swallowed.
 */
import {
  isDoneGateSatisfied,
  type DefinitionOfDoneResult,
  type LabelWriter,
} from "./definition-of-done";
import type { RunEvent } from "./run-history";
import type { RunHistoryStore } from "./run-history-store";
import { TRIGGER_LABELS } from "./trigger";

export type TerminalStatus = "succeeded" | "failed";

export interface TerminalFinalizerDeps {
  labelWriter: LabelWriter;
  runHistory: RunHistoryStore;
}

export interface TerminalFinalizeArgs {
  repo: string;
  issue: number;
  runId: string;
  terminalStatus: TerminalStatus;
  /**
   * The Definition of Done verdict. Required for `succeeded`: `df:done` is applied
   * ONLY when the gate actually passed (#271), so an agent's self-report can never
   * produce the label.
   */
  dodResult?: DefinitionOfDoneResult;
  /** Injectable for deterministic tests; defaults to now. */
  occurredAt?: string;
}

export interface TerminalFinalizeOutcome {
  applied: boolean;
  skipped?: boolean;
  error?: string;
}

export class LabelWriteError extends Error {
  readonly code = "ERR_LABEL_WRITE";
  constructor(message: string) {
    super(message);
    this.name = "LabelWriteError";
  }
}

/** In-flight labels cleared on every terminal transition. */
const CLEARED_LABELS: readonly string[] = [
  TRIGGER_LABELS.running,
  TRIGGER_LABELS.question,
];

/**
 * Marker eventId for a run that HAS been finalised.
 *
 * Idempotency keys on this marker rather than on "a `run.terminal` event with this
 * status already exists", because the Definition of Done ALREADY records
 * `run.terminal` (`succeeded`) as `dod:<runId>:terminal` before this finalizer runs.
 * Keying on mere existence would therefore skip every successful run and `df:done`
 * would never be applied.
 */
function markerEventId(runId: string): string {
  return `terminal-lifecycle:${runId}`;
}

/**
 * The failure record deliberately uses a DISTINCT eventId so that it does not
 * satisfy the idempotency marker: a run whose label writes failed must be able to
 * be finalised again on a later delivery, rather than being permanently "done".
 */
function failureEventId(runId: string): string {
  return `terminal-label-failed:${runId}`;
}

function terminalEvent(
  runId: string,
  status: TerminalStatus,
  eventId: string,
  occurredAt: string,
): RunEvent {
  return {
    eventId,
    runId,
    type: "run.terminal",
    stage: "terminal",
    status,
    occurredAt,
  };
}

export async function applyTerminalLifecycle(
  deps: TerminalFinalizerDeps,
  args: TerminalFinalizeArgs,
): Promise<TerminalFinalizeOutcome> {
  const { labelWriter, runHistory } = deps;
  const { repo, issue, runId, terminalStatus, dodResult } = args;
  const occurredAt = args.occurredAt ?? new Date().toISOString();

  // 1. Idempotency — a run is finalised at most once.
  const listed = await runHistory.listRunEvents(runId);
  const alreadyFinalised =
    listed.ok &&
    (listed.value?.items ?? []).some(
      ({ event }) =>
        event.type === "run.terminal" &&
        event.status === terminalStatus &&
        event.eventId === markerEventId(runId),
    );
  if (alreadyFinalised) {
    return { applied: false, skipped: true };
  }

  // 2. Which terminal label this run earns. `df:done` requires a PASSING Definition
  //    of Done; a run whose DoD was refused is left for human review (#271) and only
  //    the in-flight labels are cleared.
  const terminalLabel =
    terminalStatus === "succeeded"
      ? isDoneGateSatisfied(dodResult)
        ? TRIGGER_LABELS.done
        : null
      : TRIGGER_LABELS.failed;

  // 3. Apply + clean up, collecting EVERY result so nothing is swallowed.
  const writes: {
    description: string;
    result: { ok: boolean; error?: string };
  }[] = [];
  if (terminalLabel) {
    writes.push({
      description: `add ${terminalLabel}`,
      result: await labelWriter.add(repo, issue, terminalLabel),
    });
  }
  for (const label of CLEARED_LABELS) {
    writes.push({
      description: `remove ${label}`,
      result: await labelWriter.remove(repo, issue, label),
    });
  }

  const failures = writes.filter((write) => !write.result.ok);

  // 4. Fail-closed: record the failure on the run, then refuse to continue.
  if (failures.length > 0) {
    const error = failures
      .map((write) => `${write.description}: ${write.result.error ?? "unknown error"}`)
      .join("; ");
    await runHistory.appendEvent(
      terminalEvent(runId, terminalStatus, failureEventId(runId), occurredAt),
    );
    throw new LabelWriteError(`Terminal lifecycle labelling failed: ${error}`);
  }

  // 5. Record the finalised state so the idempotency check (1) holds on a re-delivery.
  await runHistory.appendEvent(
    terminalEvent(runId, terminalStatus, markerEventId(runId), occurredAt),
  );

  return { applied: true };
}