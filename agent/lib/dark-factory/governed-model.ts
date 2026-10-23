/**
 * Dark Factory — governed dynamic model (#270).
 *
 * The category-parameterized `defineDynamic` resolver shared by every agent
 * surface. It runs a cost gate FIRST, so a refusal fails the turn BEFORE the
 * provider call — the mechanism #217 established for the orchestrator, now
 * reused by the subagents.
 *
 * OPT-IN: with no gate it returns the static model unchanged, so an unconfigured
 * deployment is byte-identical to before.
 */

import { defineDynamic } from "eve";
import type { AgentStaticModelDefinition } from "eve";

import type { CostAdmission } from "./cost-gate";

export interface GovernedGate {
  /**
   * Admit a model call. Throws to refuse it before the provider call.
   *
   * Returns the reservation so the caller can settle it (#443). A gate that has
   * nothing to reconcile may return nothing.
   */
  admit(): Promise<CostAdmission | void>;
}

export interface GovernedModelInput {
  /** The model to use when no resolver is needed. */
  chatModel: AgentStaticModelDefinition;
  /** Context window reported per call (a dynamic model cannot declare it as a sibling). */
  contextWindowTokens: number;
  /** Cost gate. Throws to refuse the call before it starts. */
  gate?: GovernedGate | null;
}

/**
 * The dynamic resolver used by a CONFIGURED (gated) agent definition.
 *
 * Deliberately WITHOUT an explicit return type so TypeScript infers the sentinel
 * from `defineDynamic`; `defineAgent` requires an exact match against one of its
 * model branches, so widening it makes the definition fail to compile.
 */
export function buildGovernedDynamicModel(input: GovernedModelInput) {
  const { chatModel, contextWindowTokens, gate } = input;

  return defineDynamic({
    events: {
      "step.started": async () => {
        // The gate runs FIRST: a throw here fails the turn before any provider
        // call is made (#217 / #270).
        const admission = gate != null ? await gate.admit() : undefined;
        return {
          // #443: the reservation must travel with the model, so it can be settled
          // once the call it paid for has actually happened (or failed).
          model: admission ? withSettlement(chatModel, admission) : chatModel,
          modelContextWindowTokens: contextWindowTokens,
        };
      },
    },
  });
}

/** Usage as reported by the provider, when it reports one. */
type UsageLike = { inputTokens?: number; outputTokens?: number };

function usageOf(value: unknown): UsageLike | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = (value as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const { inputTokens, outputTokens } = usage as UsageLike;
  if (typeof inputTokens !== "number" && typeof outputTokens !== "number") return undefined;
  return usage as UsageLike;
}

/** A finish part is the only stream part that carries usage. */
function usageFromPart(part: unknown): UsageLike | undefined {
  if (typeof part !== "object" || part === null) return undefined;
  if ((part as { type?: string }).type !== "finish") return undefined;
  return usageOf(part);
}

function settleStream(stream: ReadableStream, admission: CostAdmission): ReadableStream {
  let seen: UsageLike | undefined;
  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const usage = usageFromPart(value);
          if (usage != null) seen = usage;
          controller.enqueue(value);
        }
        await admission.settleFromUsage(seen);
        controller.close();
      } catch (error) {
        await admission.settle(null);
        controller.error(error);
      }
    },
  });
}

/**
 * Wrap a model so the reservation admitted for the turn is settled once the call
 * that reservation paid for has finished, failed or stopped streaming (#443).
 *
 * A string model id is returned untouched: there is no call to observe.
 */
export function withSettlement<T>(model: T, admission: CostAdmission): T {
  if (typeof model !== "object" || model === null) return model;
  const target = model as Record<string, unknown>;

  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;

      if (property === "doGenerate") {
        return async (...args: unknown[]) => {
          try {
            const result = await value.apply(object, args);
            await admission.settleFromUsage(usageOf(result));
            return result;
          } catch (error) {
            await admission.settle(null);
            throw error;
          }
        };
      }

      if (property === "doStream") {
        return async (...args: unknown[]) => {
          try {
            const result = await value.apply(object, args);
            const stream = (result as { stream?: unknown } | null)?.stream;
            if (!(stream instanceof ReadableStream)) {
              await admission.settleFromUsage(usageOf(result));
              return result;
            }
            const patched = Object.create(Object.getPrototypeOf(result) ?? Object.prototype);
            return Object.assign(patched, result, { stream: settleStream(stream, admission) });
          } catch (error) {
            await admission.settle(null);
            throw error;
          }
        };
      }

      return value.bind(object);
    },
  }) as T;
}
