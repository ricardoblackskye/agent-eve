import { NextResponse, type NextRequest } from "next/server";
import {
  createControlStore,
  type ControlAction,
  type ControlScope,
} from "../../../../agent/lib/dark-factory/control";
import { performControlAction } from "../../../../agent/lib/dark-factory/control-service";
import { getViewerSession } from "../viewer-auth";
import { badRequest, NO_STORE_HEADERS, okJson, unauthorized } from "../responses";

function unavailable(): NextResponse {
  return NextResponse.json(
    { error: "Control state is unavailable" },
    { status: 503, headers: NO_STORE_HEADERS },
  );
}

function isAction(value: unknown): value is ControlAction {
  return value === "pause" || value === "resume" || value === "stop";
}

function isScope(value: unknown): value is ControlScope {
  return value === "factory" || value === "run";
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const viewer = await getViewerSession(request);
  if (!viewer) return unauthorized();

  let store;
  try {
    store = createControlStore();
    const factory = await store.readFactory();
    const runId = new URL(request.url).searchParams.get("runId") ?? undefined;
    const run = runId ? await store.readRun(runId) : undefined;
    const events = await store.listEvents(50);
    if (!factory.ok || run?.ok === false || !events.ok) return unavailable();
    return okJson({
      available: true,
      factory: factory.value,
      ...(runId ? { runId, run: run?.value ?? null } : {}),
      events: events.value ?? [],
    });
  } catch {
    return unavailable();
  } finally {
    await store?.close?.();
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const viewer = await getViewerSession(request);
  if (!viewer) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Expected a JSON control action.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("Expected a JSON control action object.");
  }
  const raw = body as Record<string, unknown>;
  if (!isAction(raw.action)) return badRequest("action must be pause, resume, or stop.");
  if (!isScope(raw.scope)) return badRequest("scope must be factory or run.");
  if (raw.runId !== undefined && typeof raw.runId !== "string") {
    return badRequest("runId must be a string.");
  }
  if (raw.reason !== undefined && typeof raw.reason !== "string") {
    return badRequest("reason must be a string.");
  }

  let store;
  try {
    store = createControlStore();
    const result = await performControlAction(store, {
      action: raw.action,
      scope: raw.scope,
      actor: viewer.email,
      ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
      ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
    });
    if (!result.ok) {
      return result.status === "invalid"
        ? badRequest(result.error)
        : unavailable();
    }
    return okJson({ status: result.status, state: result.state, duplicate: result.duplicate });
  } catch {
    return unavailable();
  } finally {
    await store?.close?.();
  }
}
