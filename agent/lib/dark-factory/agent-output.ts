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
 * docs/adr/0082-agent-output-the-ledger-stores-a-summary-not-a-transcript.md.
 */

import type { RunEvent, RunEventType, RunStage, RunStatus } from "./run-history";
import { sanitizeDiff } from "./diff-capture";
import { MAX_COMMENT_CHARS } from "./plan-comment";

/**
 * The ledger's canonical issue-comment reference. Derived from the public
 * `RunEvent` shape rather than redeclared, so this module cannot drift from what
 * the run ledger actually validates.
 */
type CommentReference = NonNullable<RunEvent["commentReference"]>;

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
  commentReference?: CommentReference;
}

/**
 * The run-event fields a captured item maps onto. The caller supplies the
 * identity and timestamp (`eventId`, `runId`, `occurredAt`) when it appends the
 * event, so the recorder only maps what it captured.
 */
export interface AgentOutputEvent {
  type: RunEventType;
  stage: RunStage;
  status?: RunStatus;
  commentReference?: CommentReference;
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

/** A captured, bounded record ready to be appended to the run ledger. */
export interface PreparedAgentOutput extends AgentOutputEvent {
  /** The redacted, capped text. Never a transcript. */
  text: string;
  /** True when the text was capped, so a reader knows it is partial. */
  truncated: boolean;
}

/** Raised when a captured item is not one of the agreed types. */
export class UnsupportedAgentOutputTypeError extends Error {
  readonly type: string;
  constructor(type: string) {
    super(`Unsupported agent output type "${type}"`);
    this.name = "UnsupportedAgentOutputTypeError";
    this.type = type;
  }
}

export interface AgentOutputRecorder {
  readonly profile: AgentProfile;
  /** Map a captured item onto its run-event fields. */
  toEvent(item: CapturedAgentOutput): AgentOutputEvent;
  /** Redact and cap a captured item, refusing an unsupported type. */
  prepare(item: CapturedAgentOutput): PreparedAgentOutput;
}

/**
 * The agreed taxonomy, mapped onto the run-history contract.
 *
 * A decision-question reuses `worker.question`, which validation requires to
 * carry `status: "blocked"` and which the park/resume path reads, so the
 * mapping supplies that status rather than leaving it to each caller. A
 * roadblock takes its own type because it is recoverable and keeps the run's
 * real status. A milestone is a `worker.progress` stage boundary.
 */
const EVENT_BY_TYPE: Record<AgentOutputType, AgentOutputEvent> = {
  "decision-question": {
    type: "worker.question",
    stage: "worker",
    status: "blocked",
  },
  roadblock: { type: "worker.roadblock", stage: "worker" },
  milestone: { type: "worker.progress", stage: "worker" },
};

const AGENT_PROFILES: readonly AgentProfile[] = [
  "architect",
  "developer",
  "tester",
];

function isAgentProfile(value: string): value is AgentProfile {
  return (AGENT_PROFILES as readonly string[]).includes(value);
}

class MappedAgentOutputRecorder implements AgentOutputRecorder {
  readonly profile: AgentProfile;

  constructor(profile: AgentProfile) {
    this.profile = profile;
  }

  toEvent(item: CapturedAgentOutput): AgentOutputEvent {
    const mapped = EVENT_BY_TYPE[item.type];
    return item.commentReference === undefined
      ? { ...mapped }
      : { ...mapped, commentReference: item.commentReference };
  }

  prepare(item: CapturedAgentOutput): PreparedAgentOutput {
    const mapped = EVENT_BY_TYPE[item.type];
    if (mapped === undefined) {
      throw new UnsupportedAgentOutputTypeError(item.type);
    }

    // Reuse the diff capture's sanitiser rather than adding a second
    // redaction path: it strips env-file style `DF_*` assignments and caps
    // length. It deliberately does NOT rewrite a secret echoed mid-sentence,
    // which ADR 0082 records as the boundary of this guarantee.
    const redacted = sanitizeDiff(item.text);
    const truncated = redacted.length > MAX_COMMENT_CHARS;
    const bounded = truncated
      ? redacted.slice(0, MAX_COMMENT_CHARS)
      : redacted;

    return item.commentReference === undefined
      ? { ...mapped, text: bounded, truncated }
      : { ...mapped, text: bounded, truncated, commentReference: item.commentReference };
  }
}

/** Resolve the recorder registered for an agent profile. */
export function resolveAgentOutputRecorder(
  profile: string,
): AgentOutputRecorder {
  if (!isAgentProfile(profile)) {
    throw new UnknownAgentProfileError(profile);
  }
  return new MappedAgentOutputRecorder(profile);
}
