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

/**
 * The terminal event is what RELEASES the run's active claim: `appendEvent` derives the updated summary
 * and persists it, moving the row's status to the terminal value. A refused write therefore leaves the
 * ledger believing the run is still in flight, and it must not pass unnoticed (#373).
 */
export class TerminalEventWriteError extends Error {
  readonly code = "ERR_TERMINAL_EVENT_WRITE";
  constructor(message: string) {
    super(message);
    this.name = "TerminalEventWriteError";
  }
}

/** In-flight labels cleared on every terminal transition. Exported so the operator's retire clears the SAME set. */
export const CLEARED_LABELS: readonly string[] = [
  TRIGGER_LABELS.running,
  TRIGGER_LABELS.question,
];

/**
 * Labels that describe a FINISHED attempt. A new attempt must not leave one behind: #373's re-run left
 * WebFeedPOC#161 carrying df:running AND a stale df:failed from the previous attempt, so the ticket
 * advertised two contradictory outcomes at once.
 */
export const TERMINAL_LABELS: readonly string[] = [
  TRIGGER_LABELS.done,
  TRIGGER_LABELS.failed,
];

/**
 * The statuses that mean a run is FINISHED. Mirrors `RunStatus`'s terminal half, kept as a set so
 * `isRunTerminal` reads as a question rather than as string matching at the call site.
 */
const TERMINAL_STATUSES: readonly string[] = ["succeeded", "failed", "aborted"];

/**
 * Whether this run is already terminal (#373).
 *
 * A run can reach a terminal status WITHOUT this function finalising it: the circuit breaker writes its own
 * `run.terminal` event, which is enough to release the claim. Capability-guarded, because partial store
 * doubles drive this in tests and an absent reader means 'cannot tell', which stays on the loud path.
 */
async function isRunTerminal(
  runHistory: RunHistoryStore,
  runId: string,
): Promise<boolean> {
  if (typeof runHistory.getRun !== "function") return false;
  const current = await runHistory.getRun(runId);
  return Boolean(
    current.ok && current.value && TERMINAL_STATUSES.includes(current.value.status),
  );
}

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

export interface StartLifecycleArgs {
  repo: string;
  issue: number;
}

export interface StartLifecycleOutcome {
  /** False when any of the writes failed; the failures are in `error`. */
  applied: boolean;
  /** The terminal labels actually removed. */
  cleared: string[];
  error?: string;
}

/**
 * The START half of the ticket lifecycle (#373): clear what a finished attempt left behind, then mark this
 * attempt in flight. The terminal transition already clears the in-flight labels; until this existed
 * nothing mirrored it at the start.
 *
 * Deliberately NOT fail-closed, unlike {@link applyTerminalLifecycle}. These labels are informational: the
 * terminal transition must fail closed because it states the outcome AND releases the run's claim, whereas a
 * transient GitHub error here must not stop a run that is otherwise fine. Failures are collected and
 * reported, and one failure never cancels the remaining writes.
 */
export async function applyStartLifecycle(
  deps: { labelWriter: LabelWriter },
  args: StartLifecycleArgs,
): Promise<StartLifecycleOutcome> {
  const cleared: string[] = [];
  const failures: string[] = [];

  for (const label of TERMINAL_LABELS) {
    const removed = await deps.labelWriter.remove(args.repo, args.issue, label);
    if (removed.ok) cleared.push(label);
    else failures.push(`remove ${label}: ${removed.error ?? "unknown error"}`);
  }

  const started = await deps.labelWriter.add(
    args.repo,
    args.issue,
    TRIGGER_LABELS.running,
  );
  if (!started.ok) {
    failures.push(
      `add ${TRIGGER_LABELS.running}: ${started.error ?? "unknown error"}`,
    );
  }

  return failures.length > 0
    ? { applied: false, cleared, error: failures.join("; ") }
    : { applied: true, cleared };
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
  //
  // #373 - this write is ALSO what releases the active-run claim, so its result is checked for the same
  // reason step 3 checks every label write. A refusal here is not cosmetic: the ledger keeps believing
  // the run is in flight, and a later run for the same repo+issue is refused as a duplicate delivery.
  const marker = await runHistory.appendEvent(
    terminalEvent(runId, terminalStatus, markerEventId(runId), occurredAt),
  );
  if (!marker.ok) {
    // #373: the store refuses a second terminal event for a run that is already terminal, and that refusal
    // means the claim is ALREADY released - the circuit breaker reaches a terminal status with its own
    // `run.terminal` event. Reporting it as a failure to release was the opposite of the truth. The label
    // work above still ran, so a run terminated elsewhere is still labelled correctly.
    if (await isRunTerminal(runHistory, runId)) {
      return { applied: true };
    }
    throw new TerminalEventWriteError(
      "Terminal lifecycle event write failed, so this run's claim was not released: " +
        `${marker.error ?? "the ledger refused the write"}`,
    );
  }

  return { applied: true };
}