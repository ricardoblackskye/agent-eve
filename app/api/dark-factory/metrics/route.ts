import { type NextRequest, NextResponse } from "next/server";
import { createRunHistoryStore } from "../../../../agent/lib/dark-factory/run-history-provider";
import {
  queryRunMetricsFromParams,
  type RunMetricsParams,
} from "../../../../agent/lib/dark-factory/run-query";
import { getViewerSession } from "../viewer-auth";
import {
  badRequest,
  okJson,
  serviceUnavailable,
  unauthorized,
} from "../responses";

function metricsParamsFromSearch(search: URLSearchParams): RunMetricsParams {
  return {
    repo: search.get("repo") ?? undefined,
    from: search.get("from") ?? undefined,
    to: search.get("to") ?? undefined,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const viewer = await getViewerSession(request);
  if (!viewer) return unauthorized();

  const store = createRunHistoryStore();
  try {
    const outcome = await queryRunMetricsFromParams(
      store,
      metricsParamsFromSearch(new URL(request.url).searchParams),
    );
    if (!outcome.ok) {
      return outcome.status === 400
        ? badRequest(outcome.error)
        : serviceUnavailable();
    }
    return okJson({ metrics: outcome.metrics });
  } finally {
    await store.close();
  }
}
