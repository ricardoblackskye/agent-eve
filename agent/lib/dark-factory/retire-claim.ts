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
  _deps: RetireDeps,
  _input: RetireInput,
): Promise<RetireReport> {
  throw new Error("not implemented");
}
