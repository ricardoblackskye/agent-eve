/**
 * Dark Factory — a governed agent LLM call (#270).
 *
 * The seam an AGENT CALL SITE (the runner's Architect / Developer calls) uses to
 * be budget-governed. It wraps `runGovernedLlmCall` and, on a refusal, records the
 * machine-readable reason ON THE RUN before failing — so a run stopped by the cost
 * cap is explainable on the ticket, not just in a log.
 *
 * OPT-IN: with no governor it simply runs the call, so an unconfigured deployment
 * behaves exactly as before.
 */
import { runGovernedLlmCall } from "./governed-llm-call";
import { recordCostRefusal } from "./cost-refusal-recorder";
import type { CostCategory } from "./cost-budget";
import type { CostGovernor, CostGovernorRefusal } from "./cost-governor";
import type { RunHistoryStore } from "./run-history-store";

/** Thrown when the governor refuses the call, so the call site fails closed. */
export class CostRefusedError extends Error {
  readonly reason: CostGovernorRefusal;
  constructor(reason: CostGovernorRefusal) {
    super(`the cost gate refused this call: ${reason}`);
    this.name = "CostRefusedError";
    this.reason = reason;
  }
}

export interface GovernedAgentCallDeps {
  /** Absent/null => governance is OFF and the call runs unchanged (opt-in). */
  governor?: CostGovernor | null;
  /** Optional run ledger: when present, a refusal is recorded ON THE RUN. */
  runHistory?: RunHistoryStore;
  /** The run this call belongs to; required to record a refusal. */
  runId?: string;
}

export interface GovernedAgentCallOptions<T> {
  category: CostCategory;
  /** Provider model id; an unpriced model is refused, not guessed. */
  model: string;
  /** Upper-bound token estimate used for the pre-call reservation. */
  inputTokens: number;
  outputTokens: number;
  /** The real call — invoked ONLY after the governor admits it. */
  run: () => Promise<T>;
  /** Measured cost from the result; `undefined` = unmeasured. */
  costOf?: (result: T) => number | undefined;
}

/**
 * Run a governed agent call.
 *
 * - No governor configured => run the call and return its result (unchanged).
 * - Admitted => run the call and return its result.
 * - Refused => record the code on the run (best effort) and THROW `CostRefusedError`.
 */
export async function runGovernedAgentCall<T>(
  deps: GovernedAgentCallDeps,
  options: GovernedAgentCallOptions<T>,
): Promise<T> {
  if (!deps.governor) return options.run();

  const outcome = await runGovernedLlmCall({
    governor: deps.governor,
    category: options.category,
    model: options.model,
    inputTokens: options.inputTokens,
    outputTokens: options.outputTokens,
    run: options.run,
    ...(options.costOf ? { costOf: options.costOf } : {}),
  });

  if (outcome.ok) return outcome.result;

  if (deps.runHistory && deps.runId) {
    // Best effort: the call is refused either way, but the run should say why.
    await recordCostRefusal(deps.runHistory, { runId: deps.runId, code: outcome.reason }).catch(
      () => undefined,
    );
  }
  throw new CostRefusedError(outcome.reason);
}
