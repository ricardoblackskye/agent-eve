/**
 * #404 R2 — retiring a stale claim, from the operator's point of view.
 *
 * R1's acceptance ended with a parked run holding #169's claim and a refusal that said "wait, or retire its claim if
 * the process is gone" — with no way to do the latter. This module is that way: it retires the claim through the
 * store, and reconciles the ticket's FACTORY-OWNED labels, which otherwise keep advertising a run that is not there.
 *
 * Two properties are deliberate:
 *  - a refusal changes NOTHING (no label is touched when the holder is live or there is no claim);
 *  - the LEDGER retirement is never undone by a label failure — but the ticket is then reported as unreconciled,
 *    loudly, because a ticket that still says `df:running` is the very symptom this release exists to remove.
 */
import type { LabelWriter } from "./definition-of-done";
import type { RunHistoryStore } from "./run-history-store";
import type { RunStatus } from "./run-history";
import { CLEARED_LABELS } from "./run-finalizer";

export type RetireOutcome =
  | "retired"
  | "retired-unreconciled"
  | "holder-is-live"
  | "no-claim"
  | "store-unavailable";

export interface RetireReport {
  outcome: RetireOutcome;
  repo: string;
  issue: number;
  runId?: string;
  previousStatus?: RunStatus;
  /** Factory-owned labels removed because they claimed a run was live. */
  clearedLabels: string[];
  /** One line per thing that happened, in order, for the operator to read. */
  lines: string[];
}

export interface RetireDeps {
  store: RunHistoryStore;
  /** Absent means the ledger is retired but the ticket is NOT reconciled — reported, never silent. */
  labels?: LabelWriter;
}

export interface RetireInput {
  repo: string;
  issue: number;
  /** The human's reason. Printed and returned; the ledger deliberately stores no free-form operator text. */
  reason?: string;
  actor?: string;
}

export async function retireStaleClaim(
  deps: RetireDeps,
  input: RetireInput,
): Promise<RetireReport> {
  const { repo, issue } = input;
  const base = { repo, issue, clearedLabels: [] as string[] };

  const retired = await deps.store.retireRunClaim({ repo, issue, actor: input.actor });
  if (!retired.ok) {
    return {
      ...base,
      outcome: "store-unavailable",
      lines: [
        `the run ledger is unavailable (${retired.error ?? "no detail"}), so nothing was changed.`,
      ],
    };
  }

  const value = retired.value;

  if (value?.outcome === "holder-is-live") {
    return {
      ...base,
      outcome: "holder-is-live",
      runId: value.runId,
      lines: [
        `${value.runId} is '${value.status}' — that is work in flight, so NOTHING was changed.`,
        "Stop it from the control plane, or wait for it to finish.",
      ],
    };
  }

  if (!value || value.outcome === "no-claim") {
    return {
      ...base,
      outcome: "no-claim",
      lines: [`no active run holds ${repo}#${issue}, so there was nothing to retire.`],
    };
  }

  const lines = [
    `retired ${value.runId} (was '${value.previousStatus}'): it is terminal now, and its claim is released — ` +
      "the next run for this issue may start.",
  ];
  if (input.reason) lines.push(`reason: ${input.reason}`);

  if (!deps.labels) {
    lines.push(
      `the ticket's labels were NOT reconciled (no label writer is configured): it may still carry ` +
        `${CLEARED_LABELS.join(", ")}.`,
    );
    return {
      ...base,
      outcome: "retired-unreconciled",
      runId: value.runId,
      previousStatus: value.previousStatus,
      lines,
    };
  }

  const cleared: string[] = [];
  const failed: string[] = [];
  for (const label of CLEARED_LABELS) {
    const result = await deps.labels.remove(repo, issue, label);
    if (result.ok) cleared.push(label);
    else failed.push(`${label} (${result.error ?? "no detail"})`);
  }

  if (failed.length > 0) {
    lines.push(
      `the ledger retired the run, but these labels could NOT be cleared: ${failed.join(", ")} — the ticket still ` +
        "claims a live run; clear them by hand.",
    );
    return {
      ...base,
      outcome: "retired-unreconciled",
      runId: value.runId,
      previousStatus: value.previousStatus,
      clearedLabels: cleared,
      lines,
    };
  }

  lines.push(
    `cleared the factory's in-flight labels: ${cleared.join(", ")}. No terminal label is applied — retiring is ` +
      "neither a success nor a failure.",
  );
  return {
    ...base,
    outcome: "retired",
    runId: value.runId,
    previousStatus: value.previousStatus,
    clearedLabels: cleared,
    lines,
  };
}
