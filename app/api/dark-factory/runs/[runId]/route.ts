import { type NextRequest, NextResponse } from "next/server";
import { createRunHistoryStore } from "../../../../../agent/lib/dark-factory/run-history-provider";
import {
  queryRunDetailFromParams,
  type RunEventParams,
} from "../../../../../agent/lib/dark-factory/run-query";
import { resolveViewer } from "../../viewer";
import {
  badRequest,
  forbidden,
  notFound,
  okJson,
  serviceUnavailable,
  unauthorized,
} from "../../responses";

function eventParamsFromSearch(search: URLSearchParams): RunEventParams {
  return {
    limit: search.get("limit") ?? undefined,
    cursor: search.get("cursor") ?? undefined,
  };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const resolved = await resolveViewer(request);
  if (!resolved.ok) {
    return resolved.status === 401 ? unauthorized() : forbidden(resolved.error);
  }

  const { runId } = await context.params;
  const store = createRunHistoryStore();
  try {
    const outcome = await queryRunDetailFromParams(
      store,
      runId,
      eventParamsFromSearch(new URL(request.url).searchParams),
      resolved.viewer,
    );
    if (!outcome.ok) {
      if (outcome.status === 404) return notFound();
      if (outcome.status === 400) return badRequest(outcome.error);
      return serviceUnavailable();
    }
    return okJson({
      summary: outcome.summary,
      events: outcome.events,
      nextCursor: outcome.nextCursor,
    });
  } finally {
    await store.close();
  }
}
