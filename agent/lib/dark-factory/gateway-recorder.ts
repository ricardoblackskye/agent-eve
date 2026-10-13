/**
 * #281 (R2b/B3) — record gateway decisions into run-history.
 *
 * The gateway decides BEFORE any upstream spend, and the runner's existing cost gate records refusals
 * on the run; sandbox authoring spend must be visible on the SAME run, not only in a log. This adapts
 * the gateway's optional recordUsage/recordRefusal hooks — which the core already invokes with the run id
 * from the lease — to run-history writes.
 *
 * A history outage must NOT fail a forwarded call, so both hooks swallow write errors and resolve void.
 */
import { recordCostRefusal } from "./cost-refusal-recorder";
import type { GatewayRefusalRecord, GatewayUsageRecord } from "./llm-gateway";
import type { RunHistoryStore } from "./run-history-store";

export interface GatewayRecorder {
  recordUsage: (usage: GatewayUsageRecord) => Promise<void>;
  recordRefusal: (refusal: GatewayRefusalRecord) => Promise<void>;
}

export function createGatewayRecorder(store: RunHistoryStore): GatewayRecorder {
  return {
    recordUsage: async (usage) => {
      await store
        .appendEvent({
          eventId: `gateway-usage:${usage.runId}:${usage.reservationId}`,
          runId: usage.runId,
          type: "run.cost",
          stage: "worker",
          occurredAt: new Date().toISOString(),
          status: "succeeded",
          costUsd: usage.estimatedUsd,
        })
        .catch(() => undefined);
    },
    recordRefusal: async (refusal) => {
      await recordCostRefusal(store, {
        runId: refusal.runId,
        code: refusal.reason,
      }).catch(() => undefined);
    },
  };
}
