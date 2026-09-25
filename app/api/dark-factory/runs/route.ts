import { type NextRequest, NextResponse } from "next/server";
import { createRunHistoryStore } from "../../../../agent/lib/dark-factory/run-history-provider";
import {
  queryRunListFromParams,
  type RunListParams,
} from "../../../../agent/lib/dark-factory/run-query";
import { getViewerSession } from "../viewer-auth";
import {
  badRequest,
  okJson,
  serviceUnavailable,
  unauthorized,
} from "../responses";

function listParamsFromSearch(search: URLSearchParams): RunListParams {
  const statuses = search.getAll("status");
  return {
    repo: search.get("repo") ?? undefined,
    issue: search.get("issue") ?? undefined,
    statuses: statuses.length ? statuses : undefined,
    from: search.get("from") ?? undefined,
    to: search.get("to") ?? undefined,
    limit: search.get("limit") ?? undefined,
    cursor: search.get("cursor") ?? undefined,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const viewer = await getViewerSession(request);
  if (!viewer) return unauthorized();

  const store = createRunHistoryStore();
  try {
    const outcome = await queryRunListFromParams(
      store,
      listParamsFromSearch(new URL(request.url).searchParams),
    );
    if (!outcome.ok) {
      return outcome.status === 400
        ? badRequest(outcome.error)
        : serviceUnavailable();
    }
    return okJson({ runs: outcome.runs, nextCursor: outcome.nextCursor });
  } finally {
    await store.close();
  }
}
