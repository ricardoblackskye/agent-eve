/**
 * Dark Factory — orchestration handler (#268).
 *
 * The `DispatchHandler` that runs the factory pipeline in sequence:
 *
 *     developer  →  tester  →  pr
 *
 * It owns SEQUENCE and TRANSLATION only. All retry/backoff, parking, status
 * persistence, dedup, control-gating and the per-invocation deadline live in
 * `Dispatcher` (see ./dispatch.ts) and are reused UNCHANGED.
 *
 * Stage outcomes map onto the Dispatcher's control vocabulary:
 *   - a stage RETURNS               -> continue; a clean finish records `succeeded`
 *   - a stage THROWS `Error`        -> retryable (Dispatcher applies DEFAULT_RETRY_POLICY)
 *   - a stage THROWS `ParkedRunError` -> `blocked`: NO retry, NO backoff burn (#162)
 *
 * Stages are INJECTED so the handler is unit-testable with no GitHub / LLM /
 * network. The real stage wiring (DeveloperAgent / TesterAgent /
 * definition-of-done) is composed separately and exercised by the end-to-end
 * pipeline test (#269).
 */

import {
  ParkedRunError,
  type DispatchCheckpoint,
  type DispatchEvent,
  type DispatchHandler,
} from "./dispatch";

import { recordRunDiff } from "./diff-capture";
import { type RunHistoryStore } from "./run-history-store";

/** Context handed to every stage: the dispatch event and the routed worker. */
export interface FactoryStageContext {
  event: DispatchEvent;
  worker: string;
}

/** Outcome of the pre-PR tester gate. */
export interface TesterStageResult {
  /** Whether the gate passed. */
  passed: boolean;
  /** The stage parked the run on a HUMAN decision (#162): no retry, `blocked`. */
  parked?: boolean;
  /** Human-readable reason (used only when the gate did not pass). */
  reason?: string;
}

/**
 * The three pipeline stages. Each receives the run context and the cooperative
 * checkpoint; a stage MAY invoke the checkpoint itself inside a long loop.
 */
/** Optional result a developer stage may return so the orchestrator can capture + persist the produced patch. */
export interface DeveloperStageResult {
  /** Run id to record the diff against; defaults to the dispatch event's runId. */
  runId?: string;
  /** The developer agent's work tree; a `git diff` here is captured + sanitized. */
  workspaceDir?: string;
}

export interface FactoryStages {
  developer(
    ctx: FactoryStageContext,
    checkpoint: DispatchCheckpoint,
  ): Promise<void | DeveloperStageResult>;
  tester(ctx: FactoryStageContext, checkpoint: DispatchCheckpoint): Promise<TesterStageResult>;
  pr(ctx: FactoryStageContext, checkpoint: DispatchCheckpoint): Promise<void>;
}

export interface DispatchHandlerDeps {
  stages: FactoryStages;
  /** Optional run-history store; when present, developer-stage diffs are captured. */
  runHistory?: RunHistoryStore;
  /** Override the diff-capture used after the developer stage (defaults to `recordRunDiff`). */
  captureDiff?: (
    store: RunHistoryStore,
    runId: string,
    workspaceDir: string,
  ) => Promise<void>;
}

export function createDispatchHandler(deps: DispatchHandlerDeps): DispatchHandler {
  return async (event, worker, checkpoint) => {
    const ctx: FactoryStageContext = { event, worker };

    await checkpoint();
    const devResult = await deps.stages.developer(ctx, checkpoint);
    if (deps.runHistory && devResult && devResult.workspaceDir) {
      const capture = deps.captureDiff ?? recordRunDiff;
      await capture(
        deps.runHistory,
        devResult.runId ?? event.runId,
        devResult.workspaceDir,
      );
    }

    await checkpoint();
    const tester = await deps.stages.tester(ctx, checkpoint);
    if (!tester.passed) {
      // A question parks the run (#162): no retry, no backoff burn. A plain
      // failure is thrown so the Dispatcher retries it within the budget.
      if (tester.parked) {
        throw new ParkedRunError(
          tester.reason ?? "worker needs a human decision",
        );
      }
      throw new Error(
        `Tester gate failed: ${tester.reason ?? "validation failed"}`,
      );
    }

    await checkpoint();
    await deps.stages.pr(ctx, checkpoint);
  };
}
