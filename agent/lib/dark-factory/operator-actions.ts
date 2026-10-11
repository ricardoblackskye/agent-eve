/**
 * #307 — operator actions that reach the LEDGER (retry / abort).
 *
 * The control plane (#264) owns the cooperative pause/stop FLAGS. Two operator actions
 * additionally need the run ledger:
 *
 * - `abort` — end a run terminally, producing the run-history status `aborted`, which is
 *   what distinguishes it from a flag-only `stop` (the ledger has no `stopped` status).
 * - `retry` — re-dispatch a FAILED run as a NEW run.
 *
 * Both reuse the existing machinery rather than inventing a second one: `abort` drives the
 * ledger's existing `RunControlTransition` abort, and `retry` drives the ordinary trigger
 * path. The delivery identity is derived from the RUN (there is no webhook here), so a
 * repeated click reuses one identity and the ledger's claim/accept dedupe it rather than
 * acting twice.
 */
import type { EntryDeps, EntryResult } from "./entry";
import type { RunHistoryStore } from "./run-history-store";
import type { DarkFactoryTriggerDecision } from "./trigger";

export type OperatorRunAction = "abort" | "retry";

export type DispatchFn = (
  decision: DarkFactoryTriggerDecision,
  deps: EntryDeps,
) => Promise<EntryResult>;

export interface OperatorActionDeps {
  runHistory: RunHistoryStore;
  dispatch: DispatchFn;
  labels?: EntryDeps["labels"];
  env?: Record<string, string | undefined>;
  now?: () => string;
}

export interface OperatorActionInput {
  action: OperatorRunAction;
  runId: string;
  actor: string;
  reason?: string;
}

export interface OperatorActionResult {
  ok: boolean;
  status: string;
  reason: string;
  runId?: string;
  error?: string;
}

/**
 * The delivery identity is derived from the RUN, so a double-click cannot act twice: the
 * ledger's `claimControlDelivery` (abort) and `acceptDelivery` (retry) both dedupe on it.
 */
export function operatorDeliveryId(
  action: OperatorRunAction,
  runId: string,
): string {
  return `operator-${action}:${runId}`;
}

export async function performOperatorRunAction(
  deps: OperatorActionDeps,
  input: OperatorActionInput,
): Promise<OperatorActionResult> {
  const { runHistory, dispatch } = deps;
  const { action, runId, actor } = input;
  const now = deps.now ?? (() => new Date().toISOString());

  const run = await runHistory.getRun(runId);
  if (!run.ok) {
    const error = run.error ?? "unknown storage error";
    return {
      ok: false,
      status: "unavailable",
      reason: `could not read the run: ${error}`,
      error,
    };
  }
  const summary = run.value;
  if (!summary) {
    return {
      ok: false,
      status: "refused",
      reason: `there is no run '${runId}' to act on`,
    };
  }

  // Retry is only meaningful for a run that actually failed.
  if (action === "retry" && summary.status !== "failed") {
    return {
      ok: false,
      status: "refused",
      runId,
      reason: `only a failed run can be retried; '${runId}' is ${summary.status}`,
    };
  }

  // A GENERATED, bounded reason. The operator's own free-text reason is recorded on the
  // control surface (a control event / the run's control state), never in the ledger.
  const decision: DarkFactoryTriggerDecision = {
    kind: action === "abort" ? "abort" : "trigger",
    reason:
      action === "abort"
        ? `an operator aborted ${summary.repo}#${summary.issue}`
        : `an operator retried ${summary.repo}#${summary.issue}`,
    repo: summary.repo,
    issue: summary.issue,
    actor,
  };

  const result = await dispatch(decision, {
    runHistory,
    ...(deps.labels ? { labels: deps.labels } : {}),
    env: deps.env ?? process.env,
    deliveryId: operatorDeliveryId(action, runId),
    now,
  });

  return {
    ok: result.ok,
    status: result.status,
    reason: result.reason,
    ...(result.runId ? { runId: result.runId } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}
