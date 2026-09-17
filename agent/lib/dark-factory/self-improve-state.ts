/**
 * Dark Factory — self-improvement PERSISTENCE adapters (#146, R4b).
 *
 * `self-improve.ts` deliberately imports no store: the controller is
 * storage-agnostic, and this module is the one place that binds the loop to the
 * existing `StateStore` seam (#134). Two things need durability:
 *
 *  - the CADENCE WATERMARK — when a cycle last ran, so the caller's scheduler can
 *    ask "is a cycle due?" without a long-lived timer.
 *  - OPERATOR DECISIONS — a pre-armed human allow/deny for a (surface, kind)
 *    pair, which `operatorGateFromStore` turns into the `OperatorGate` the
 *    controller already consumes.
 *
 * Both use a single key holding a JSON value, because `StateStore` exposes only
 * `save(key, value)` / `get(key)` — there is no key enumeration, so a list of
 * decisions is stored as an array and upserted in place.
 */

import type { StateStore } from "./state";
import type { OperatorGate, Proposal } from "./self-improve";

/** Key holding the serialised operator decision list. */
export const OPERATOR_DECISIONS_KEY = "self-improve:operator-decisions";

/** Key holding the ISO timestamp of the last completed cycle. */
export const CADENCE_WATERMARK_KEY = "self-improve:cadence-watermark";

/** A durability failure — distinct from a configuration error. */
export class SelfImprovementStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfImprovementStateError";
  }
}

export type OperatorDecisionValue = "allow" | "deny";

export interface OperatorDecision {
  surfaceId: string;
  kind: Proposal["kind"];
  decision: OperatorDecisionValue;
  /** Who armed it — recorded for audit, not authenticated. */
  decidedBy: string;
  decidedAt: string;
  /** ISO expiry, or null for "until superseded". */
  expiresAt: string | null;
}

export interface OperatorDecisionStore {
  /** Upsert a decision for its (surfaceId, kind) pair. */
  record(decision: OperatorDecision): Promise<void>;
  /** The live decision, or null when absent OR expired. */
  get(
    surfaceId: string,
    kind: Proposal["kind"],
    now?: () => Date,
  ): Promise<OperatorDecision | null>;
  list(): Promise<OperatorDecision[]>;
  clear(surfaceId: string, kind: Proposal["kind"]): Promise<void>;
}

/**
 * An expiry we cannot read is treated as EXPIRED, never as "still valid": a
 * corrupt timestamp must not silently extend an operator's approval.
 */
function isExpired(decision: OperatorDecision, now?: () => Date): boolean {
  if (decision.expiresAt === null) return false;
  const expiry = Date.parse(decision.expiresAt);
  if (Number.isNaN(expiry)) return true;
  const at = (now ? now() : new Date()).getTime();
  return at >= expiry;
}

export function createOperatorDecisionStore(
  store: StateStore,
): OperatorDecisionStore {
  async function loadAll(): Promise<OperatorDecision[]> {
    const result = await store.get<OperatorDecision[]>(OPERATOR_DECISIONS_KEY);
    if (!result.ok || !Array.isArray(result.value)) return [];
    return result.value;
  }

  async function saveAll(all: OperatorDecision[]): Promise<void> {
    const result = await store.save(OPERATOR_DECISIONS_KEY, all);
    if (!result.ok) {
      // Never report a decision as armed when it did not reach the store: the
      // operator would believe access was granted when it was not recorded.
      throw new SelfImprovementStateError(
        `Could not persist the operator decision via '${store.id}' (${result.error ?? result.mode}).`,
      );
    }
  }

  const sameTarget = (a: OperatorDecision, surfaceId: string, kind: string) =>
    a.surfaceId === surfaceId && a.kind === kind;

  return {
    async record(decision: OperatorDecision): Promise<void> {
      const all = await loadAll();
      // Upsert: one decision per (surface, kind) pair, the newest wins.
      const next = all.filter(
        (existing) => !sameTarget(existing, decision.surfaceId, decision.kind),
      );
      next.push(decision);
      await saveAll(next);
    },

    async get(
      surfaceId: string,
      kind: Proposal["kind"],
      now?: () => Date,
    ): Promise<OperatorDecision | null> {
      const found = (await loadAll()).find((decision) =>
        sameTarget(decision, surfaceId, kind),
      );
      if (!found) return null;
      return isExpired(found, now) ? null : found;
    },

    async list(): Promise<OperatorDecision[]> {
      return loadAll();
    },

    async clear(surfaceId: string, kind: Proposal["kind"]): Promise<void> {
      const all = await loadAll();
      await saveAll(
        all.filter((decision) => !sameTarget(decision, surfaceId, kind)),
      );
    },
  };
}

/**
 * Turn recorded decisions into the `OperatorGate` the controller consumes.
 * Fail-closed in every degenerate case: nothing recorded, an expired decision,
 * or an explicit `deny` all refuse.
 */
export function operatorGateFromStore(
  decisions: OperatorDecisionStore,
  now?: () => Date,
): OperatorGate {
  return {
    approve: async (proposal: Proposal): Promise<boolean> => {
      const live = await decisions.get(proposal.surfaceId, proposal.kind, now);
      return live?.decision === "allow";
    },
  };
}

/** Bind the cadence watermark to a `StateStore`. */
export function createCadenceWatermark(store: StateStore): {
  read(): Promise<string | null>;
  write(at: string): Promise<void>;
} {
  return {
    async read(): Promise<string | null> {
      const result = await store.get<string>(CADENCE_WATERMARK_KEY);
      if (!result.ok || typeof result.value !== "string") return null;
      return result.value;
    },

    async write(at: string): Promise<void> {
      const result = await store.save(CADENCE_WATERMARK_KEY, at);
      if (!result.ok) {
        // A lost watermark means the cadence would re-run every invocation and
        // burn the cost budget, so this must not fail silently.
        throw new SelfImprovementStateError(
          `Could not persist the cadence watermark via '${store.id}' (${result.error ?? result.mode}).`,
        );
      }
    },
  };
}
