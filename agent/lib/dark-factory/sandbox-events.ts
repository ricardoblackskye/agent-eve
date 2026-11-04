/**
 * #585 T2 (AC3) — the NDJSON event stream for sandbox provisioning.
 *
 * WHY THIS EXISTS: the provisioning core knows when a stage starts and ends, but its
 * only output was one prose line at the very end. The GUI (#582) had to screen-scrape
 * to know whether it was stuck in vendor or in deploy. A caller needs structured events
 * to render progress and to branch on a stage without parsing English.
 *
 * The contract: one JSON object per line on stdout, nothing else. Human prose goes to
 * stderr. The terminal event is always `step: "done"` and carries the exit code, so a
 * consumer can stop on one line instead of inferring completion from silence.
 *
 * The emitter takes its write channel as an argument. That is what keeps it testable —
 * a test collects lines in an array instead of capturing a real stdout — and what lets
 * the CLI write to process.stdout while a test writes to memory.
 */

export type ProvisionStep =
  | "check"
  | "vendor"
  | "cluster"
  | "deploy"
  | "forward"
  | "proof"
  | "teardown"
  | "done";

export type ProvisionPhase = "start" | "success" | "failure" | "skip";

export interface ProvisionEvent {
  /** ISO-8601 UTC. The consumer renders ordering; it never has to guess. */
  ts: string;
  step: ProvisionStep;
  phase: ProvisionPhase;
  /** Short and human-readable. Structured detail goes in optional extra keys. */
  message: string;
  /** Present on the terminal `done` event only. */
  exitCode?: number;
}

/** An event without its timestamp: the emitter stamps it. */
export type ProvisionEventInput = Omit<ProvisionEvent, "ts">;

export interface NdjsonEmitterOptions {
  /** Where each serialized line goes. The CLI passes process.stdout.write. */
  write: (line: string) => void;
  /** Injectable clock so tests get a deterministic timestamp. */
  now?: () => Date;
}

/**
 * Builds the emitter the core calls. Each call serializes exactly one JSON object and
 * appends a newline — the NDJSON framing a line-wise reader needs.
 */
export function createNdjsonEmitter(
  options: NdjsonEmitterOptions,
): (event: ProvisionEventInput) => void {
  const now = options.now ?? (() => new Date());
  return (event) => {
    const line: ProvisionEvent = { ts: now().toISOString(), ...event };
    options.write(`${JSON.stringify(line)}\n`);
  };
}

/** An emitter that discards events. The default when a caller passes no `onEvent`. */
export const noopEmitter = (): void => {
  /* intentional: a caller that does not want events still gets a valid core */
};
