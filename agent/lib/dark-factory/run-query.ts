import {
  ALL_RUN_STATUSES,
  normalizeRunDateRange,
  type RunMetrics,
  type RunMetricsQuery,
  type RunStatus,
  type RunSummary,
} from "./run-history";
import {
  type EventCursor,
  type PersistedRunEvent,
  type RunCursor,
  type RunHistoryStore,
} from "./run-history-store";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Opaque, URL-safe pagination cursor codec. The public API never exposes the
 * store's internal cursor shape (createdAt + runId, or sequence), so a host
 * change cannot leak storage-specific identifiers and a tampered cursor fails
 * closed to a 400 rather than being trusted.
 */
interface ListCursorPayload {
  v: 1;
  c: RunCursor;
}
interface EventCursorPayload {
  v: 1;
  e: EventCursor;
}

function base64UrlEncode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function base64UrlDecode<T>(token: string): T | null {
  try {
    const text = Buffer.from(token, "base64url").toString("utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function encodeListCursor(cursor: RunCursor): string {
  return base64UrlEncode({ v: 1, c: cursor } satisfies ListCursorPayload);
}

export function decodeListCursor(token: string): RunCursor | null {
  const payload = base64UrlDecode<ListCursorPayload>(token);
  if (!payload || payload.v !== 1 || !payload.c) return null;
  const { createdAt, runId } = payload.c;
  if (typeof createdAt !== "string" || typeof runId !== "string") return null;
  return { createdAt, runId };
}

export function encodeEventCursor(cursor: EventCursor): string {
  return base64UrlEncode({ v: 1, e: cursor } satisfies EventCursorPayload);
}

export function decodeEventCursor(token: string): EventCursor | null {
  const payload = base64UrlDecode<EventCursorPayload>(token);
  if (!payload || payload.v !== 1 || !payload.e) return null;
  const { sequence } = payload.e;
  if (typeof sequence !== "number" || !Number.isInteger(sequence)) return null;
  return { sequence };
}

export interface RunListParams {
  repo?: string;
  issue?: string;
  statuses?: readonly string[];
  from?: string;
  to?: string;
  limit?: string;
  cursor?: string;
}

export interface RunEventParams {
  limit?: string;
  cursor?: string;
}

export interface RunMetricsParams {
  repo?: string;
  from?: string;
  to?: string;
}

export type RunListRequest = {
  repo?: string;
  issue?: number;
  statuses?: RunStatus[];
  from?: string;
  to?: string;
  limit: number;
  cursor?: RunCursor;
};

export type RunEventRequest = {
  limit: number;
  cursor?: EventCursor;
};

export type RunMetricsRequest = RunMetricsQuery;

export type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

export function validateRunListParams(
  params: RunListParams,
): ValidationResult<RunListRequest> {
  const request: RunListRequest = { limit: DEFAULT_PAGE_SIZE };

  if (params.repo !== undefined) {
    const repo = params.repo.trim();
    if (!repo)
      return { ok: false, error: "repo must be a non-empty owner/name" };
    request.repo = repo;
  }

  if (params.issue !== undefined) {
    const issue = Number.parseInt(params.issue, 10);
    if (!Number.isInteger(issue) || issue <= 0)
      return { ok: false, error: "issue must be a positive integer" };
    request.issue = issue;
  }

  if (params.statuses && params.statuses.length > 0) {
    const statuses: RunStatus[] = [];
    for (const raw of params.statuses) {
      if (!ALL_RUN_STATUSES.includes(raw as RunStatus))
        return { ok: false, error: `unknown status '${raw}'` };
      statuses.push(raw as RunStatus);
    }
    request.statuses = statuses;
  }

  try {
    const range = normalizeRunDateRange(params.from, params.to);
    request.from = range.from;
    request.to = range.to;
  } catch {
    return {
      ok: false,
      error: "from and to must be ISO timestamps with from before to",
    };
  }

  if (params.limit !== undefined) {
    const limit = Number.parseInt(params.limit, 10);
    if (!Number.isInteger(limit) || limit < 1)
      return { ok: false, error: "limit must be a positive integer" };
    if (limit > MAX_PAGE_SIZE)
      return { ok: false, error: `limit must not exceed ${MAX_PAGE_SIZE}` };
    request.limit = limit;
  }

  if (params.cursor !== undefined) {
    const cursor = decodeListCursor(params.cursor);
    if (!cursor) return { ok: false, error: "invalid pagination cursor" };
    request.cursor = cursor;
  }

  return { ok: true, value: request };
}

export function validateRunEventParams(
  params: RunEventParams,
): ValidationResult<RunEventRequest> {
  const request: RunEventRequest = { limit: DEFAULT_PAGE_SIZE };

  if (params.limit !== undefined) {
    const limit = Number.parseInt(params.limit, 10);
    if (!Number.isInteger(limit) || limit < 1)
      return { ok: false, error: "limit must be a positive integer" };
    if (limit > MAX_PAGE_SIZE)
      return { ok: false, error: `limit must not exceed ${MAX_PAGE_SIZE}` };
    request.limit = limit;
  }

  if (params.cursor !== undefined) {
    const cursor = decodeEventCursor(params.cursor);
    if (!cursor) return { ok: false, error: "invalid pagination cursor" };
    request.cursor = cursor;
  }

  return { ok: true, value: request };
}

export function validateRunMetricsParams(
  params: RunMetricsParams,
): ValidationResult<RunMetricsRequest> {
  const request: RunMetricsRequest = {};

  if (params.repo !== undefined) {
    const repo = params.repo.trim();
    if (!repo)
      return { ok: false, error: "repo must be a non-empty owner/name" };
    request.repo = repo;
  }

  try {
    const range = normalizeRunDateRange(params.from, params.to);
    request.from = range.from;
    request.to = range.to;
  } catch {
    return {
      ok: false,
      error: "from and to must be ISO timestamps with from before to",
    };
  }

  return { ok: true, value: request };
}

export type RunListOutcome =
  | { ok: true; runs: RunSummary[]; nextCursor: string | null }
  | { ok: false; status: 400 | 503; error: string };

export type RunDetailOutcome =
  | {
      ok: true;
      summary: RunSummary;
      events: PersistedRunEvent[];
      nextCursor: string | null;
    }
  | { ok: false; status: 400 | 404 | 503; error: string };

export type RunMetricsOutcome =
  | { ok: true; metrics: RunMetrics }
  | { ok: false; status: 400 | 503; error: string };

export async function queryRunList(
  store: RunHistoryStore,
  request: RunListRequest,
): Promise<RunListOutcome> {
  const result = await store.listRuns({
    repo: request.repo,
    issue: request.issue,
    statuses: request.statuses,
    from: request.from,
    to: request.to,
    limit: request.limit,
    cursor: request.cursor,
  });
  if (!result.ok)
    return { ok: false, status: 503, error: "run history is unavailable" };
  const page = result.value;
  if (!page)
    return { ok: false, status: 503, error: "run history is unavailable" };
  return {
    ok: true,
    runs: page.items,
    nextCursor: page.nextCursor ? encodeListCursor(page.nextCursor) : null,
  };
}

export async function queryRunListFromParams(
  store: RunHistoryStore,
  params: RunListParams,
): Promise<RunListOutcome> {
  const validation = validateRunListParams(params);
  if (!validation.ok)
    return { ok: false, status: 400, error: validation.error };
  return queryRunList(store, validation.value);
}

export async function queryRunDetail(
  store: RunHistoryStore,
  runId: string,
  request: RunEventRequest,
): Promise<RunDetailOutcome> {
  const summaryResult = await store.getRun(runId);
  if (!summaryResult.ok)
    return { ok: false, status: 503, error: "run history is unavailable" };
  if (summaryResult.value === null)
    return { ok: false, status: 404, error: "run not found" };

  const eventsResult = await store.listRunEvents(runId, {
    limit: request.limit,
    after: request.cursor,
  });
  if (!eventsResult.ok)
    return { ok: false, status: 503, error: "run history is unavailable" };
  const eventsPage = eventsResult.value;
  if (!eventsPage)
    return { ok: false, status: 503, error: "run history is unavailable" };

  return {
    ok: true,
    summary: summaryResult.value,
    events: eventsPage.items,
    nextCursor: eventsPage.nextCursor
      ? encodeEventCursor(eventsPage.nextCursor)
      : null,
  };
}

export async function queryRunDetailFromParams(
  store: RunHistoryStore,
  runId: string,
  params: RunEventParams,
): Promise<RunDetailOutcome> {
  const validation = validateRunEventParams(params);
  if (!validation.ok)
    return { ok: false, status: 400, error: validation.error };
  return queryRunDetail(store, runId, validation.value);
}

export async function queryRunMetrics(
  store: RunHistoryStore,
  request: RunMetricsRequest,
): Promise<RunMetricsOutcome> {
  const result = await store.getRunMetrics(request);
  if (!result.ok)
    return { ok: false, status: 503, error: "run history is unavailable" };
  const metrics = result.value;
  if (!metrics)
    return { ok: false, status: 503, error: "run history is unavailable" };
  return { ok: true, metrics };
}

export async function queryRunMetricsFromParams(
  store: RunHistoryStore,
  params: RunMetricsParams,
): Promise<RunMetricsOutcome> {
  const validation = validateRunMetricsParams(params);
  if (!validation.ok)
    return { ok: false, status: 400, error: validation.error };
  return queryRunMetrics(store, validation.value);
}
