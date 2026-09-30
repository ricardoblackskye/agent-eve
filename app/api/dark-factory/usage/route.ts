import { type NextRequest, NextResponse } from "next/server";
import { createUsageStore } from "../../../../agent/lib/dark-factory/usage-store-provider";
import { queryUsage } from "../../../../agent/lib/dark-factory/usage-query";
import { getViewerSession } from "../viewer-auth";
import {
  badRequest,
  okJson,
  serviceUnavailable,
  unauthorized,
} from "../responses";

/**
 * Operator-only, read-only view of the LLM usage ledger (#209).
 *
 * Reuses the shared signed-session gate and the structured response helpers.
 * Counts only: no prompt or completion text is ever read or returned, and a
 * malformed window is a 400 (caller error) while an unavailable ledger is a 503
 * (operational), so an operator is not sent hunting for the wrong problem.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const viewer = await getViewerSession(request);
  if (!viewer) return unauthorized();

  const store = createUsageStore();
  try {
    const params = new URL(request.url).searchParams;
    const outcome = await queryUsage(store, {
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
      runId: params.get("runId") ?? undefined,
      model: params.get("model") ?? undefined,
    });

    if (!outcome.ok) {
      return outcome.status === 400
        ? badRequest(outcome.error)
        : serviceUnavailable();
    }
    return okJson({ report: outcome.report });
  } finally {
    await store.close?.();
  }
}