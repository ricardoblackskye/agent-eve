import { type NextRequest, NextResponse } from "next/server";
import {
  CHAT_MODEL_ENV,
  DEFAULT_MODEL_ID,
  FALLBACK_MODEL_ID,
  resolveModelId,
} from "../../../../agent/model-config";
import { EnvConfigError } from "../../../../agent/lib/dark-factory/llm-policy";
import { buildLlmPolicyReport } from "../../../../agent/lib/dark-factory/llm-policy-query";
import { getViewerSession } from "../viewer-auth";
import { badRequest, okJson, unauthorized } from "../responses";

/** Matches `scripts/pr-reviewer.ts`; the reviewer keeps its own model default. */
const PR_REVIEW_FALLBACK_MODEL = "deepseek/deepseek-chat";

/**
 * Operator-only, read-only view of the effective LLM call policy (#208).
 *
 * The policy is env-driven, so this reports what the current deployment will
 * actually do — including per-surface degradation where a model cannot reason.
 * It exposes no secret: only the policy values and the resolved model ids.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const viewer = await getViewerSession(request);
  if (!viewer) return unauthorized();

  const env = process.env;
  // Use the real resolver so the report matches what the orchestrator does,
  // rather than approximating the model from the raw env var.
  const chatModel = resolveModelId({
    primary: DEFAULT_MODEL_ID,
    fallback: FALLBACK_MODEL_ID,
    envOverride: env[CHAT_MODEL_ENV],
  });
  const reviewModel =
    (env.PR_REVIEW_MODEL ?? "").trim() || PR_REVIEW_FALLBACK_MODEL;

  try {
    const report = buildLlmPolicyReport(env, [
      { surface: "orchestrator", defaultModel: chatModel },
      { surface: "worker", defaultModel: chatModel },
      { surface: "pr-review", defaultModel: reviewModel },
    ]);
    return okJson({ report });
  } catch (error) {
    // A malformed policy is a configuration error, not an outage: 400.
    if (error instanceof EnvConfigError) return badRequest(error.message);
    throw error;
  }
}
