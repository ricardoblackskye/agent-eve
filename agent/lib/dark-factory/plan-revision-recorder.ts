/**
 * Dark Factory — how many times a parked plan has been sent back (#378).
 *
 * A reply that is not an explicit approval is plan feedback, which costs one architect call and re-parks
 * the run. That is deliberately safe, but it is not free and not unbounded: an unrelated comment or a
 * chatty thread could send the architect round the loop forever. This module is the durable count the
 * runner refuses against.
 *
 * Mirrors `breaker-trip-recorder.ts` and `cost-refusal-recorder.ts` deliberately — same append shape,
 * same idempotency on a derived event id, same honest failure reporting instead of throwing.
 */
import { createHash } from "node:crypto";
import type { RunHistoryStore } from "./run-history-store";

export interface RecordPlanRevisionInput {
  runId: string;
  /**
   * Identity of the human reply that asked for the revision, so a re-delivered comment records ONCE.
   * The delivery identity is what the human DID, not GitHub's own delivery id.
   */
  revisionId: string;
  occurredAt?: string;
}

export interface PlanRevisionWriteResult {
  ok: boolean;
  error?: string;
}

export interface PlanRevisionCountResult {
  ok: boolean;
  count: number;
  error?: string;
}

export function countPlanRevisions(_events: readonly { type: string }[]): number {
  throw new Error("not implemented");
}

export function isPlanRevisionCapReached(_count: number, _cap: number): boolean {
  throw new Error("not implemented");
}

export async function recordPlanRevision(
  _history: RunHistoryStore,
  _input: RecordPlanRevisionInput,
): Promise<PlanRevisionWriteResult> {
  throw new Error("not implemented");
}

export async function readPlanRevisionCount(
  _history: RunHistoryStore,
  _runId: string,
): Promise<PlanRevisionCountResult> {
  throw new Error("not implemented");
}
