/**
 * Agent output capture (#558, epic #557).
 *
 * One extendable seam that turns each Agent's notable output into typed, capped
 * and redacted records on the run ledger. The agreed taxonomy is deliberately
 * small - decision-questions, roadblocks and milestones - and maps onto the
 * run-history event types rather than inventing a parallel vocabulary.
 *
 * Ledger posture (#558 decision 2): the ledger stores a bounded, redacted
 * summary plus the comment reference, never a transcript. See
 * docs/adr/0082-*.md.
 */

import type { RunEventType, RunStage, RunStatus } from "./run-history";

/** The agreed set of capturable output types. Anything else is not captured. */
export type AgentOutputType = "decision-question" | "roadblock" | "milestone";

/** The agent profiles that opt into capture. */
export type AgentProfile = "architect" | "developer" | "tester";

/**
 * One captured piece of agent output, before it is mapped to a run event.
 * `text` is bounded and already redacted by the recorder.
 */
export interface CapturedAgentOutput {
  profile: AgentProfile;
  type: AgentOutputType;
  text: string;
  /** The issue comment carrying the readable form, when one was posted. */
  commentReference?: string;
}

/** The run-event shape a captured item maps onto. */
export interface AgentOutputEvent {
  type: RunEventType;
  stage: RunStage;
  status?: RunStatus;
  commentReference?: string;
}

/** Raised when a profile has no registered recorder. */
export class UnknownAgentProfileError extends Error {
  readonly profile: string;
  constructor(profile: string) {
    super(`No agent-output recorder is registered for profile "${profile}"`);
    this.name = "UnknownAgentProfileError";
    this.profile = profile;
  }
}

export interface AgentOutputRecorder {
  readonly profile: AgentProfile;
  /** Map a captured item onto its run-event shape. */
  toEvent(item: CapturedAgentOutput, occurredAt: string): AgentOutputEvent;
}

/** Resolve the recorder registered for an agent profile. */
export function resolveAgentOutputRecorder(
  _profile: string,
): AgentOutputRecorder {
  throw new Error("not implemented");
}
