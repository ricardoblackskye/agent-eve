# Dark Factory Run Query API

> **Stability**: Stable  
> **Auth**: Required (viewer session)  
> **Cache**: `private, no-store`  
> **Provider**: Neutral (SQLite/PG swap via `DF_RUN_HISTORY_DRIVER`)

## Base Path

All endpoints are under `/api/dark-factory`.

## Authentication

Requests must include a valid `eve_session` cookie (see [`app/auth-session.ts`](../app/auth-session.ts)). Missing or invalid session → **401 Unauthorized**.

## Common Responses

All successful responses include:

```http
Cache-Control: private, no-store
Content-Type: application/json
```

Error responses (4xx/5xx) return JSON:

```json
{ "error": "human-readable message" }
```

### Error Codes

| Code | Meaning                                                                              |
|------|--------------------------------------------------------------------------------------|
| 400  | Invalid query parameter (malformed cursor, bad ISO date, out-of-range `limit`, etc.) |
| 401  | Missing or invalid viewer session                                                    |
| 404  | Run not found (`/runs/[runId]`)                                                      |
| 503  | Run history service unavailable (mis‑configured or blocked store)                    |

## Endpoints

### GET `/api/dark-factory/runs`

Returns a paginated list of run summaries matching the filters.

#### Query Parameters for GET /runs

| Parameter  | Type                                        | Description                                                                                                                           |
|------------|---------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| `repo`     | string (optional)                           | Filter by repository (`owner/name`).                                                                                                  |
| `issue`    | string (optional)                           | Filter by issue number (as string).                                                                                                   |
| `statuses` | CSV string (optional)                       | Filter by run status (`queued`, `succeeded`, `failed`, `aborted`). Repeat for multiple values: `?statuses=succeeded&statuses=failed`. |
| `from`     | ISO-8601 string (optional)                  | Inclusive lower bound on `createdAt`.                                                                                                 |
| `to`       | ISO-8601 string (optional)                  | Exclusive upper bound on `createdAt`. Must be strictly after `from` if both present.                                                  |
| `limit`    | integer (optional, default `25`, max `100`) | Page size.                                                                                                                            |
| `cursor`   | string (optional)                           | Opaque pagination cursor from previous response.                                                                                      |

#### Successful Response (200) for GET /runs

```json
{
  "runs": [ RunSummary, … ],
  "nextCursor": string | null
}
```

`RunSummary` shape (see `agent/lib/dark-factory/run-history.ts`):

```ts
interface RunSummary {
  runId: string;
  repo: string;
  issue: number;
  status: RunStatus; // "queued" | "succeeded" | "failed" | "aborted"
  stage: RunStage; // "accepted" | "dispatch" | "review" | "worker" | "terminal"
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  startedAt?: string; // ISO-8601 (present after start)
  completedAt?: string; // ISO-8601 (present after terminal)
  attemptCount: number;
  reviewCount: number;
  iterationCount: number;
  fixCycleCount: number;
  latencyMs?: number; // present if measured
  costUsd?: number; // present if measured
  prUrl?: string; // present if a PR was opened
}
```

If `nextCursor` is non‑null, use it as the `cursor` param for the next page. Cursors are base64url‑encoded, tamper‑evident, and contain no store‑internal identifiers.

#### Examples for GET /runs

- **First page**, repo `owner/repo`, limit 10:  
  `GET /api/dark-factory/runs?repo=owner/repo&limit=10`

- **Next page** (assuming previous response gave `nextCursor: "AbC..."`):  
  `GET /api/dark-factory/runs?cursor=AbC...`

- **Date range**, failed runs only:  
  `GET /api/dark-factory/runs?from=2026-09-24T00:00:00.000Z&to=2026-09-25T00:00:00.000Z&statuses=failed`

### GET `/api/dark-factory/runs/[runId]`

Returns a single run summary with its paginated event stream.

#### Path Parameter for GET /runs/[runId]

- `runId`: the run identifier (from `/runs` list or webhook).

#### Query Parameters for GET /runs/[runId]

| Parameter | Type                                        | Description                                      |
|-----------|---------------------------------------------|--------------------------------------------------|
| `limit`   | integer (optional, default `50`, max `200`) | Page size for events.                            |
| `cursor`  | string (optional)                           | Opaque pagination cursor from previous response. |

#### Successful Response (200) for GET /runs/[runId]

```json
{
  "summary": RunSummary,
  "events": [ { sequence: number, event: PersistedRunEvent }, … ],
  "nextCursor": string | null
}
```

`PersistedRunEvent` shape (see `agent/lib/dark-factory/run-history-store.ts`):

```ts
interface PersistedRunEvent {
  sequence: number; // 1‑based, monotonic per run
  event: {
    eventId: string;
    runId: string;
    type: string; // e.g. "run.accepted", "dispatch.started", "worker.step", "run.terminal"
    stage: RunStage;
    occurredAt: string; // ISO-8601
    status?: RunStatus; // nullable, only present on terminal events and some worker events
    // … optional measurement fields (latencyMs, costUsd, etc.) omitted for brevity
  };
}
```

If `nextCursor` is non‑null, use it as the `cursor` param for the next page of events.

#### Examples for GET /runs/[runId]

- **Get run with first 50 events**:  
  `GET /api/dark-factory/runs/run-xyz123`

- **Get next page of events** (limit unchanged):  
  `GET /api/dark-factory/runs/run-xyz123?cursor=next-page-token`

### GET `/api/dark-factory/metrics`

Returns definition‑of‑done (DOD) aggregated metrics over the filtered run set.

#### Query Parameters for GET /metrics

Same as `/runs` (`repo`, `issue`, `statuses`, `from`, `to`).

#### Successful Response (200) for GET /metrics

```json
{
  "metrics": {
    "statusCounts": [
      { status: RunStatus, count: number },
      …
    ],
    "trend": [
      { date: string (YYYY-MM-DD), count: number },
      …
    ],
    "measured": {
      "latencyMs": { sum: number, count: number },
      "costUsd": { sum: number, count: number }
    }
  }
}
```

- `statusCounts`: one object for **every** canonical `RunStatus` (`queued`, `succeeded`, `failed`, `aborted`), even if the count is zero.
- `trend`: daily count of runs that reached `stage: "terminal"` (i.e. completed) on that calendar day (UTC), only for days with at least one terminal run; absent days are omitted (not zero).
- `measured`: sums and observation counts for the optional numeric fields `latencyMs` and `costUsd`; if no run reported a field, both `sum` and `count` are `0`.

#### Examples for GET /metrics

- **Overall metrics** (no filters):  
  `GET /api/dark-factory/metrics`

- **Metrics for a repo in September 2026**:  
  `GET /api/dark-factory/metrics?repo=owner/repo&from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z`

## Implementation Notes

- The API is **provider‑neutral**: the same routes work against SQLite (`DF_RUN_HISTORY_DRIVER=sqlite`) or PostgreSQL (`DF_RUN_HISTORY_DRIVER=postgres`) without code changes.
- Cursor tokens are opaque and unguessable; tampering results in a 400.
- No endpoint mutates state; all are safe, idempotent reads.
- Maximum page sizes (`limit`) are enforced to prevent OOM.
- Percent-encode reserved characters in query values (for example, the `/` in `owner/repo`).

## Error Examples

### 400 – Invalid `issue` filter

```http
HTTP/1.1 400 Bad Request
Cache-Control: private, no-store
Content-Type: application/json

{ "error": "issue must be a positive integer" }
```

### 401 – Missing session

```http
HTTP/1.1 401 Unauthorized
Cache-Control: private, no-store
Content-Type: application/json

{ "error": "Missing or invalid viewer session" }
```

### 404 – Unknown run

```http
HTTP/1.1 404 Not Found
Cache-Control: private, no-store
Content-Type: application/json

{ "error": "Run not found" }
```

### 503 – Store mis‑configured

```http
HTTP/1.1 503 Service Unavailable
Cache-Control: private, no-store
Content-Type: application/json

{ "error": "Run history is unavailable" }
```