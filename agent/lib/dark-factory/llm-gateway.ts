import type { CostGovernor, CostGovernorRefusal } from "./cost-governor";
import { randomUUID } from "node:crypto";
import { runGovernedLlmCall } from "./governed-llm-call";
import { resolvePrice as resolvePriceFromBudget, type ModelPrice } from "./cost-budget";

/**
 * #281 (R2) T3 — the governed model gateway, core decisions (the route stays thin).
 *
 * The sandboxed CLI has its model calls routed back here so the SAME cost/policy gates apply as the
 * in-process loop. Two properties matter more than anything else in this module:
 *
 *  1. REFUSE BEFORE FORWARDING. A refused call must cost nothing, so the governor decides before any
 *     upstream request is made.
 *  2. The provider key is NEVER held here. The caller injects `forwardUpstream`, closing over the key
 *     server-side, so this module cannot leak it into a result, a record, a metric or an error.
 */

export interface GatewayLease {
  runId: string;
  tenantId?: string | undefined;
}

/** Deny-by-default: an unknown or absent token resolves to nothing. Never throws for a bad token. */
export interface LeaseAuthority {
  resolve(token: string | undefined): GatewayLease | undefined;
}

/** Issues opaque, run-bound tokens. R3 (#282) replaces the STORAGE with the credential vault; this
 *  check and every caller stay unchanged. */
export interface LeaseIssuer {
  issue(lease: GatewayLease): string;
  revoke(token: string): void;
}

/** ONE message for every lease failure, so the endpoint is not a lease-state oracle. */
export const LEASE_REFUSED_MESSAGE = "unauthorized";

export interface GatewayUsageRecord {
  runId: string;
  tenantId?: string | undefined;
  model: string;
  reservationId: string;
  /** The RESERVATION estimate. Kept for the trail; superseded by `costUsd` when one was measured. */
  estimatedUsd: number;
  /** Measured input tokens from the upstream response. Absent stays absent, never 0. */
  tokensIn?: number | undefined;
  /** Measured output tokens from the upstream response. */
  tokensOut?: number | undefined;
  /** The SETTLED cost, when one was measured. A reservation estimate is not an actual. */
  costUsd?: number | undefined;
}

/** What the gateway could measure from a forwarded call (#532). Every field is optional by design. */
export interface GatewayMeasurement {
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  /** Absent when the model has no known price: an unpriced call is not a free one. */
  costUsd?: number | undefined;
}

/**
 * Measure a forwarded call from the upstream response (#532).
 *
 * The gateway already receives the provider's own usage for the call it just paid for, so the sandbox's
 * spend can be recorded as a MEASUREMENT rather than a reservation estimate. Reads the OpenAI-compatible
 * `usage` block; anything else yields absent fields, because a shape the provider did not send is not a
 * measurement. PURE: no network, no clock, no environment — the price resolver is injectable so a test can
 * move a rate.
 */
export function measureGatewayUsage(
  result: unknown,
  model: string,
  resolvePrice?: (model: string | null | undefined) => ModelPrice | null,
): GatewayMeasurement {
  const usage = (result as { usage?: unknown } | null | undefined)?.usage;
  if (!usage || typeof usage !== "object") return {};
  const block = usage as Record<string, unknown>;

  const count = (...names: string[]): number | undefined => {
    for (const name of names) {
      const value = block[name];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
    return undefined;
  };
  // Both spellings: OpenRouter speaks the OpenAI one, and a gateway that fronts providers should not
  // lose a measurement because a vendor named the field differently.
  const tokensIn = count("prompt_tokens", "input_tokens");
  const tokensOut = count("completion_tokens", "output_tokens");

  // ONE PRICE SOURCE: the governor's own resolver, so a settled cost can never disagree with a
  // reservation. Cost needs BOTH counts — half a measurement is not a cost.
  const price = (resolvePrice ?? resolvePriceFromBudget)(model);
  const costUsd =
    price && tokensIn !== undefined && tokensOut !== undefined
      ? (tokensIn / 1000) * price.inputUsdPer1k + (tokensOut / 1000) * price.outputUsdPer1k
      : undefined;

  return {
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

export interface GatewayRefusalRecord {
  runId: string;
  tenantId?: string | undefined;
  model: string;
  reason: CostGovernorRefusal;
}

export interface LlmGatewayDeps {
  /** ABSENT = governance is not configured. The gateway then REFUSES rather than forwarding
   *  ungoverned: falling open here is exactly the regression this gateway exists to prevent. */
  governor?: CostGovernor | undefined;
  leases: LeaseAuthority;
  /** Pinned models the gateway will forward. Anything else is rejected BEFORE any spend. */
  allowedModels: readonly string[];
  /** Forwards an admitted call. Injected so tests need no provider key and the key stays server-side. */
  forwardUpstream: (args: { model: string; payload: unknown }) => Promise<unknown>;
  recordUsage?: (usage: GatewayUsageRecord) => Promise<void>;
  /**
   * #532 — a usage-ledger sink for the sandbox's spend, built per call by the composition root.
   *
   * A factory rather than a sink because the run id and model arrive with the lease, and a function
   * rather than an import because this module must not read the environment: the same reason the
   * provider key is injected. Returning null means no usage driver is configured, which is the opt-in.
   */
  workerUsage?: (context: { runId: string; model: string }) =>
    | { record(measurement?: {
        taskType?: string;
        tokensIn?: number;
        tokensOut?: number;
        costUsd?: number;
        durationMs?: number;
      }): Promise<boolean> }
    | null;
  recordRefusal?: (refusal: GatewayRefusalRecord) => Promise<void>;
}

export interface GatewayRequest {
  /** Raw `Authorization` header value. */
  authorization: unknown;
  model: unknown;
  payload: unknown;
  inputTokens: number;
  outputTokens: number;
}

export type GatewayResult =
  | { status: 200; body: unknown }
  | { status: 400 | 401 | 402 | 502; error: string; reason?: CostGovernorRefusal };

/** Extract the bearer token from an Authorization header. */
/**
 * An in-process lease authority: the token is an opaque random id, the lease lives server-side, and
 * nothing about it is derivable from the token itself. Revoking an unknown token is a no-op (never an
 * error), so revocation cannot be probed either.
 */
export function createInMemoryLeaseAuthority(): LeaseAuthority & LeaseIssuer {
  const leases = new Map<string, GatewayLease>();
  return {
    issue: (lease: GatewayLease) => {
      const token = randomUUID();
      leases.set(token, { ...lease });
      return token;
    },
    resolve: (token: string | undefined) => (token ? leases.get(token) : undefined),
    revoke: (token: string) => {
      leases.delete(token);
    },
  };
}

export function bearerToken(authorization: unknown): string | undefined {
  if (typeof authorization !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1];
}

export async function handleGatewayRequest(
  request: GatewayRequest,
  deps: LlmGatewayDeps,
): Promise<GatewayResult> {
  // 1. Deny by default. One message for every cause, so a caller cannot probe lease state.
  const lease = deps.leases.resolve(bearerToken(request.authorization) ?? "");
  if (!lease) return { status: 401, error: LEASE_REFUSED_MESSAGE };

  // 2. Model allow-list BEFORE governance and before any upstream call.
  const model = typeof request.model === "string" ? request.model : "";
  if (!deps.allowedModels.includes(model)) return { status: 400, error: "model_not_allowed" };

  // 2b. FAIL CLOSED when governance is not configured. The in-process gate treats "ungoverned" as
  // "behave as before", which is right for a pre-existing local path and WRONG here: this endpoint
  // exists only to keep sandbox spend gated, so with no governor it must refuse, not forward.
  if (!deps.governor) {
    await deps.recordRefusal?.({
      runId: lease.runId,
      tenantId: lease.tenantId,
      model,
      reason: "not_configured",
    });
    return { status: 402, error: "budget_refused", reason: "not_configured" };
  }

  try {
    // 3. The SAME governed seam the in-process loop uses: reserve -> run -> settle. A refusal is
    // returned (not thrown) and is decided BEFORE `run` is invoked, so a refused call never reaches
    // the provider and costs nothing.
    // #532: the provider's usage is in the response this call returns, so the sandbox's spend can be
    // MEASURED rather than left as a reservation estimate. One helper feeds both the settle and the
    // ledger, so the two can never disagree.
    const measure = (result: unknown) => measureGatewayUsage(result, model);
    const developerUsage = deps.workerUsage?.({ runId: lease.runId, model }) ?? null;

    const governed = await runGovernedLlmCall({
      governor: deps.governor,
      category: "developer",
      model,
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
      ...(lease.tenantId ? { tenantId: lease.tenantId } : {}),
      // The SETTLED cost, so the reservation stops settling null.
      costOf: (result: unknown) => measure(result).costUsd,
      // Opt-in: absent when no usage driver is configured, and then nothing is recorded.
      ...(developerUsage
        ? {
            usage: {
              taskType: "developer",
              sink: developerUsage,
              measurementOf: (result: unknown) => measure(result),
            },
          }
        : {}),
      run: () => deps.forwardUpstream({ model, payload: request.payload }),
    });

    if (!governed.ok) {
      await deps.recordRefusal?.({
        runId: lease.runId,
        tenantId: lease.tenantId,
        model,
        reason: governed.reason,
      });
      return { status: 402, error: "budget_refused", reason: governed.reason };
    }

    const measured = measure(governed.result);
    await deps.recordUsage?.({
      runId: lease.runId,
      tenantId: lease.tenantId,
      model,
      reservationId: governed.reservationId,
      estimatedUsd: governed.estimatedUsd,
      // Absent fields stay absent: a call this gateway could not measure is not a free one.
      ...(measured.tokensIn !== undefined ? { tokensIn: measured.tokensIn } : {}),
      ...(measured.tokensOut !== undefined ? { tokensOut: measured.tokensOut } : {}),
      ...(measured.costUsd !== undefined ? { costUsd: measured.costUsd } : {}),
    });
    return { status: 200, body: governed.result };
  } catch {
    // The seam has already settled, so nothing is leaked. Deliberately generic: an upstream error
    // can carry provider internals, and this response goes back into the sandbox.
    return { status: 502, error: "upstream_error" };
  }
}
