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
import { runGovernedLlmCall, type GovernedLlmCallResult } from "./governed-llm-call";
import { CostRefusedError } from "./cost-governor";
import { recordCostRefusal } from "./cost-refusal-recorder";
import type { CostCategory } from "./cost-budget";
import type { CostGovernor } from "./cost-governor";
import type { RunHistoryStore } from "./run-history-store";

/**
 * Thrown when the governor refuses the call, so the call site fails closed.
 *
 * ONE refusal class now lives in `cost-governor.ts` (#458), carrying the whole decision.
 * It is re-exported here so existing importers of this module keep working.
 */
export { CostRefusedError };

export interface GovernedAgentCallDeps {
  /** Absent/null => governance is OFF and the call runs unchanged (opt-in). */
  governor?: CostGovernor | null;
  /** Optional run ledger: when present, a refusal is recorded ON THE RUN. */
  runHistory?: RunHistoryStore;
  /** The run this call belongs to; required to record a refusal. */
  runId?: string;
}

/**
 * Best-effort usage recording for a governed call (#492).
 *
 * The shape mirrors `WorkerUsageSink` in `developer-agent.ts`: a NARROW structural contract, so this seam stays free
 * of any store dependency, and the call site decides whether a sink exists at all. Recording is scoped to ONE call
 * site — the architect's — so the developer and tester paths keep writing exactly what they wrote before.
 */
export interface UsageMeasurement {
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
}

export interface GovernedCallUsage<T> {
  /** The task type recorded on the event, e.g. "architect". */
  taskType: string;
  /** Best-effort sink. A failure is logged, never thrown at the call it measures. */
  sink: { record(measurement?: UsageMeasurement & { taskType?: string }): Promise<boolean> };
  /** Measured usage from the call's result. An absent field stays ABSENT on the event, never 0. */
  measurementOf?: (result: T) => UsageMeasurement;
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
  /** Usage-ledger recording (#492). Absent means no usage event — the opt-in default. */
  usage?: GovernedCallUsage<T>;
}

/**
 * Run a governed agent call.
 *
 * - No governor configured => run the call and return its result (unchanged).
 * - Admitted => run the call and return its result.
 * - Refused => record the code on the run (best effort) and THROW `CostRefusedError`.
 *
 * Usage recording (#492) is INDEPENDENT of governance: a supplied sink records whenever the call RAN, with or
 * without a governor, because the budget category and the usage ledger are separate subsystems. A REFUSED call
 * records nothing — nothing ran, so there is nothing to attribute.
 */
export async function runGovernedAgentCall<T>(
  deps: GovernedAgentCallDeps,
  options: GovernedAgentCallOptions<T>,
): Promise<T> {
  const usage = options.usage;

  /**
   * Best-effort: the ledger must never fail the call it measures. The measurement is spread, never defaulted, so a
   * field that was not measured stays ABSENT on the event (the ledger reports it as `unmeasured`, never as zero).
   */
  const recordUsage = async (result?: T): Promise<void> => {
    if (!usage) return;
    try {
      await usage.sink.record({
        taskType: usage.taskType,
        ...(usage.measurementOf && result !== undefined ? usage.measurementOf(result) : {}),
      });
    } catch (error) {
      console.warn(
        `[usage] governed call usage was not recorded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  // The condition for recording is that the call RAN, not that it SUCCEEDED: a failed call still spends (the
  // governor settles its reservation), so the ledger acknowledges it with an unmeasured event rather than silence.
  let callRan = false;
  const run = async (): Promise<T> => {
    callRan = true;
    return options.run();
  };

  if (!deps.governor) {
    try {
      const result = await run();
      await recordUsage(result);
      return result;
    } catch (error) {
      if (callRan) await recordUsage();
      throw error;
    }
  }

  let outcome: GovernedLlmCallResult<T>;
  try {
    outcome = await runGovernedLlmCall({
      governor: deps.governor,
      category: options.category,
      model: options.model,
      inputTokens: options.inputTokens,
      outputTokens: options.outputTokens,
      run,
      ...(options.costOf ? { costOf: options.costOf } : {}),
    });
  } catch (error) {
    // `callRan` distinguishes "the call ran and threw" from "the governor could not even admit it": only the
    // former spent anything.
    if (callRan) await recordUsage();
    throw error;
  }

  if (outcome.ok) {
    await recordUsage(outcome.result);
    return outcome.result;
  }

  if (deps.runHistory && deps.runId) {
    // Best effort: the call is refused either way, but the run should say why.
    await recordCostRefusal(deps.runHistory, { runId: deps.runId, code: outcome.reason }).catch(
      () => undefined,
    );
  }
  throw new CostRefusedError({ reason: outcome.reason, category: options.category });
}
