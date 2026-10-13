import { type NextRequest, NextResponse } from "next/server";
import {
  createCostBudgetStore,
  isCostGovernanceConfigured,
} from "../../../agent/lib/dark-factory/cost-budget-store";
import { createCostGovernor } from "../../../agent/lib/dark-factory/cost-governor";
import {
  createInMemoryLeaseAuthority,
  handleGatewayRequest,
  type LlmGatewayDeps,
} from "../../../agent/lib/dark-factory/llm-gateway";
import { createRunHistoryStore } from "../../../agent/lib/dark-factory/run-history-provider";
import { createGatewayRecorder } from "../../../agent/lib/dark-factory/gateway-recorder";

/**
 * #281 (R2) T3 — the governed model gateway. OpenAI-compatible, and deliberately THIN: every decision
 * lives in `llm-gateway.ts` so it is unit-testable without HTTP.
 *
 * A sandboxed CLI points its base URL here and presents a per-run lease as its API key. The provider
 * key never leaves this process: `forwardUpstream` closes over it server-side, and the module that
 * makes decisions cannot see it.
 */

/** One authority per server process. R3 (#282) replaces the STORAGE with the credential vault. */
const leases = createInMemoryLeaseAuthority();
const runHistory = createRunHistoryStore();
const gatewayRecorder = createGatewayRecorder(runHistory);

/** Deny by default: with no allow-list configured, NO model is forwarded. */
function allowedModels(env: NodeJS.ProcessEnv): string[] {
  return (env.DF_LLM_GATEWAY_MODELS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Forward an admitted call upstream. Errors stay generic: the detail never reaches the sandbox. */
async function forwardUpstream(
  model: string,
  payload: unknown,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const base = (
    env.DF_LLM_GATEWAY_UPSTREAM ?? "https://openrouter.ai/api/v1"
  ).replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENROUTER_API_KEY ?? ""}`,
    },
    body: JSON.stringify({ ...(payload as Record<string, unknown>), model }),
  });
  if (!response.ok) throw new Error(`upstream responded ${response.status}`);
  return response.json();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = process.env;
  const payload = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  // Upper-bound estimates for the pre-call reservation, matching the in-process loop's approach.
  const serialized = JSON.stringify(payload ?? {});
  const maxTokens =
    typeof payload?.max_tokens === "number" ? payload.max_tokens : 8_000;

  const deps: LlmGatewayDeps = {
    // Absent when governance is not configured, and then the core REFUSES rather than forwarding
    // ungoverned — the in-process gate's "behave as before" default is wrong for this endpoint.
    ...(isCostGovernanceConfigured(env)
      ? { governor: createCostGovernor(createCostBudgetStore(env), env) }
      : {}),
    leases,
    allowedModels: allowedModels(env),
    forwardUpstream: ({ model, payload: body }) =>
      forwardUpstream(model, body, env),
    recordUsage: (usage) => gatewayRecorder.recordUsage(usage),
    recordRefusal: (refusal) => gatewayRecorder.recordRefusal(refusal),
  };

  const result = await handleGatewayRequest(
    {
      authorization: request.headers.get("authorization"),
      model: payload?.model,
      payload,
      inputTokens: Math.ceil(serialized.length / 4),
      outputTokens: maxTokens,
    },
    deps,
  );

  if (result.status === 200)
    return NextResponse.json(result.body, { status: 200 });
  return NextResponse.json(
    {
      error: result.error,
      ...(result.reason ? { reason: result.reason } : {}),
    },
    { status: result.status },
  );
}
