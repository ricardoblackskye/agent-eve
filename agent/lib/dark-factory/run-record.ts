/**
 * Dark Factory — open a run's record at the start of a run (#316).
 *
 * A run driven by `scripts/dark-factory-runner.ts` used to leave **no trace** in the ledger: the
 * runner invented its own id (`run-<issue>-<ts>`), which nothing else knew, so the run could not
 * appear in the dashboard and the events it later appended (terminal lifecycle, breaker trip)
 * attached to a run the ledger had never seen.
 *
 * This module fixes that by using the existing seam. **The LEDGER owns run identity**: it mints
 * the run id and is idempotent per delivery, so the same attempt is a no-op rather than a
 * duplicate. The runner adopts the id that comes back and uses it for everything downstream —
 * which also makes a runner-driven run addressable by the dashboard's control actions.
 *
 * A ledger that refuses (an unconfigured driver) must not stop a local run, so the failure is
 * reported **loudly** and the attempt id is used as a fallback. It is never a silent claim of
 * recording, and it never throws.
 */
import type { RunHistoryStore } from "./run-history-store";

export interface BeginRunRecordInput {
  history: RunHistoryStore;
  /**
   * The attempt's stable identity (the runner's `--run-id`). This is the DELIVERY identity, not
   * the run's — the ledger mints that — and repeating this value is a no-op.
   */
  attemptId: string;
  repo: string;
  issue: number;
  receivedAt?: string;
  /** Sink for the honest reporting; defaults to `console.error`. */
  log?: (message: string) => void;
}

export interface BeginRunRecordResult {
  /** The id every later write must use. */
  runId: string;
  /** True when the ledger accepted (or already knew) this attempt. */
  recorded: boolean;
  /** True when the ledger could not record it, so `runId` is the fallback attempt id. */
  fellBack: boolean;
  error?: string;
  /**
   * Set when the ledger refused because another run holds this (repo, issue). Carried STRUCTURALLY so the
   * start guard decides on a field rather than on the wording of a message (#373).
   */
  activeConflict?: { runId: string; status: string };
}

/**
 * The delivery identity for an attempt. Namespaced with `runner:` so it can never collide with a
 * webhook delivery id (`comment:<id>`, `operator-<action>:<runId>`, …).
 */
/**
 * Whether a run-history driver is configured at all. The advice "set DF_RUN_HISTORY_DRIVER" is only
 * true when this is false (#373); otherwise it sends an operator to check the one thing already correct.
 */
function driverConfigured(): boolean {
  return (process.env.DF_RUN_HISTORY_DRIVER ?? "").trim() !== "";
}

export function runnerDeliveryId(attemptId: string): string {
  return `runner:${attemptId.trim()}`;
}

/**
 * Whether this run may start, and if not, why. `null` means start.
 *
 * The distinction this draws is the fix for #373's orphan. An UNCONFIGURED ledger is a local convenience:
 * the runner falls back to the attempt id, loudly, so a developer needs no database. An ACTIVE CONFLICT is
 * the ledger saying another run owns this issue, and carrying on there is not a degraded mode — it is a
 * second run on one issue, writing its lifecycle to a run the ledger never minted. That is how a stale
 * claim became permanent: the writes went somewhere the ledger could not see, so nothing released it.
 *
 * The decision reads `activeConflict`, never the message text; the message is reused only because it already
 * names the holder and its status.
 */
export function refuseToStartReason(
  result: BeginRunRecordResult,
): string | null {
  if (!result.activeConflict) return null;
  // The explanation is reused rather than rebuilt, because it already names the holder, its status and
  // the issue. Only the CONSEQUENCE is added - and as its own sentence, so the message does not read as
  // one run-on chain of 'so ... so ...'.
  return (
    `${result.error ?? "Another run already holds this issue"}. ` +
    `This run will not start: wait for that run to finish, or retire its claim if the process is gone.`
  );
}

export async function beginRunRecord(
  input: BeginRunRecordInput,
): Promise<BeginRunRecordResult> {
  const log = input.log ?? ((message: string) => console.error(message));
  const attemptId = input.attemptId.trim();

  let accepted;
  try {
    accepted = await input.history.acceptDelivery({
      deliveryId: runnerDeliveryId(attemptId),
      repo: input.repo,
      issue: input.issue,
      receivedAt: input.receivedAt ?? new Date().toISOString(),
    });
  } catch (error) {
    // A malformed repo/issue, or a store that rejects outright. Never fatal to the run.
    const message = error instanceof Error ? error.message : String(error);
    log(
      `[WARN] The run record could not be opened (${message}); this run will not be recorded.`,
    );
    return {
      runId: attemptId,
      recorded: false,
      fellBack: true,
      error: message,
    };
  }

  // #373 - the ADR 0026 atomic active-run claim arrives as `ok: true` with an `activeConflict` and NO
  // value, so the check below would call it a refusal and report no reason. Name the holder instead: it
  // is the one fact an operator needs, and without it a stale claim is invisible and unexplained.
  if (accepted.activeConflict) {
    const { runId: holderRunId, status: holderStatus } = accepted.activeConflict;
    const conflict =
      `the ledger already holds an active run (${holderRunId}, status '${holderStatus}') for ` +
      `${input.repo}#${input.issue}, so this attempt was not recorded`;
    log(`[WARN] The run record could not be opened: ${conflict}.`);
    return {
      runId: attemptId,
      recorded: false,
      fellBack: true,
      error: conflict,
      activeConflict: { runId: holderRunId, status: holderStatus },
    };
  }

  if (!accepted.ok || !accepted.value) {
    const error = accepted.error ?? "the ledger refused the delivery";
    // #373 - the old advice said "set DF_RUN_HISTORY_DRIVER" unconditionally, which is false when the
    // driver is set and the store simply refused. Point at the store that actually answered instead.
    const advice = driverConfigured()
      ? `The store in use is '${accepted.providerId}'.`
      : `Set DF_RUN_HISTORY_DRIVER to record runs.`;
    log(
      `[WARN] The run record could not be opened (${error}); this run will not be recorded. ${advice}`,
    );
    return { runId: attemptId, recorded: false, fellBack: true, error };
  }

  const runId = accepted.value.runId;
  if (accepted.duplicate) {
    log(
      `[INFO] Attempt '${attemptId}' was already recorded; reusing run ${runId}.`,
    );
  }
  return { runId, recorded: true, fellBack: false };
}
