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
import type { MembershipRole } from "./membership";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * How many store pages a scoped (customer) list may walk to fill one page.
 * Scope filtering happens in the query layer, so a page can come back sparse
 * when other tenants' runs are interleaved; the bound keeps the walk finite.
 */
export const MAX_SCOPE_FILL_PAGES = 10;

/** The tenant scope resolved for a request. An operator is unscoped. */
export interface RunScope {
  role: MembershipRole;
  /** Present for a customer; absent for an operator (who sees every tenant). */
  tenantId?: string;
}

/**
 * A run is visible to an operator always, and to a customer only when the run's
 * write-once tenant attribution matches the customer's tenant. Fail-closed: a
 * customer with no tenant, and a run with no attribution, are never visible.
 */
export function isRunVisible(
  scope: RunScope,
  summary: Pick<RunSummary, "tenantId">,
): boolean {
  if (scope.role === "operator") return true;
  if (scope.tenantId === undefined) return false;
  return summary.tenantId === scope.tenantId;
}

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
  | { ok: false; status: 400 | 403 | 503; error: string };

export async function queryRunList(
  store: RunHistoryStore,
  request: RunListRequest,
  scope: RunScope = { role: "operator" },
): Promise<RunListOutcome> {
  const visible = (items: RunSummary[]): RunSummary[] =>
    scope.role === "operator"
      ? items
      : items.filter((item) => isRunVisible(scope, item));

  const runs: RunSummary[] = [];
  let cursor = request.cursor;
  let nextCursor: string | null = null;

  // An unscoped (operator) read is a single pass: the store's page is already
  // authoritative, and looping could duplicate rows across pages. Only a scoped
  // read walks further, because other tenants' runs are filtered out and a page
  // can come back sparse. The walk can under-fill, never over-share: only
  // visible runs are ever returned.
  const passes = scope.role === "operator" ? 1 : MAX_SCOPE_FILL_PAGES;
  for (let page = 0; page < passes; page += 1) {
    const result = await store.listRuns({
      repo: request.repo,
      issue: request.issue,
      statuses: request.statuses,
      from: request.from,
      to: request.to,
      limit: request.limit,
      cursor,
    });
    if (!result.ok || !result.value)
      return { ok: false, status: 503, error: "run history is unavailable" };

    runs.push(...visible(result.value.items));
    nextCursor = result.value.nextCursor
      ? encodeListCursor(result.value.nextCursor)
      : null;
    if (runs.length >= request.limit || !result.value.nextCursor) break;
    cursor = result.value.nextCursor;
  }

  return { ok: true, runs: runs.slice(0, request.limit), nextCursor };
}

export async function queryRunListFromParams(
  store: RunHistoryStore,
  params: RunListParams,
  scope: RunScope = { role: "operator" },
): Promise<RunListOutcome> {
  const validation = validateRunListParams(params);
  if (!validation.ok)
    return { ok: false, status: 400, error: validation.error };
  return queryRunList(store, validation.value, scope);
}

export async function queryRunDetail(
  store: RunHistoryStore,
  runId: string,
  request: RunEventRequest,
  scope: RunScope = { role: "operator" },
): Promise<RunDetailOutcome> {
  const summaryResult = await store.getRun(runId);
  if (!summaryResult.ok)
    return { ok: false, status: 503, error: "run history is unavailable" };
  // A run outside the caller's scope is reported as absent, so the response
  // never confirms that another tenant's run exists.
  if (summaryResult.value === null || !isRunVisible(scope, summaryResult.value))
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
  scope: RunScope = { role: "operator" },
): Promise<RunDetailOutcome> {
  const validation = validateRunEventParams(params);
  if (!validation.ok)
    return { ok: false, status: 400, error: validation.error };
  return queryRunDetail(store, runId, validation.value, scope);
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
  scope: RunScope = { role: "operator" },
): Promise<RunMetricsOutcome> {
  const validation = validateRunMetricsParams(params);
  if (!validation.ok)
    return { ok: false, status: 400, error: validation.error };
  // Run metrics are a factory-wide aggregate with no tenant dimension yet, so a
  // customer is refused rather than shown a figure that spans every tenant.
  if (scope.role !== "operator")
    return { ok: false, status: 403, error: "run metrics are operator-only" };
  return queryRunMetrics(store, validation.value);
}
