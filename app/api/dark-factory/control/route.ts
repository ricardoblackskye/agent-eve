import { NextResponse, type NextRequest } from "next/server";
import {
  createControlStore,
  toControlEvent,
  type ControlAction,
  type ControlScope,
} from "../../../../agent/lib/dark-factory/control";
import { performControlAction } from "../../../../agent/lib/dark-factory/control-service";
import { performOperatorRunAction } from "../../../../agent/lib/dark-factory/operator-actions";
import { runDarkFactoryDispatch } from "../../../../agent/lib/dark-factory/entry";
import { createGitHubLabelWriter } from "../../../../agent/lib/dark-factory/issue-writer";
import { createRunHistoryStore } from "../../../../agent/lib/dark-factory/run-history-provider";
import { guardOperator } from "../guard";
import { badRequest, NO_STORE_HEADERS, okJson } from "../responses";

function unavailable(): NextResponse {
  return NextResponse.json(
    { error: "Control state is unavailable" },
    { status: 503, headers: NO_STORE_HEADERS },
  );
}

function isAction(value: unknown): value is ControlAction {
  return (
    value === "pause" ||
    value === "resume" ||
    value === "stop" ||
    value === "abort" ||
    value === "retry"
  );
}

function isScope(value: unknown): value is ControlScope {
  return value === "factory" || value === "run";
}

/**
 * #307 — the two operator actions that reach the LEDGER, as opposed to the control-state
 * flags. `abort` ends a run terminally (`aborted`, which the ledger distinguishes from a
 * flag-only `stop`); `retry` re-dispatches a FAILED run as a new run.
 *
 * Both are operator-guarded by the caller and recorded with the acting operator: `abort`
 * writes the run's control state (actor + reason), `retry` appends a control event (it
 * changes no state).
 */
async function operatorRunAction(
  action: "abort" | "retry",
  actor: string,
  runId: string,
  reason: string | undefined,
): Promise<NextResponse> {
  let controlStore;
  let runHistory;
  try {
    controlStore = createControlStore();
    runHistory = createRunHistoryStore();

    if (action === "abort") {
      // The cooperative flag first, so a still-running run halts at its next checkpoint,
      // then the terminal ledger transition.
      const flagged = await performControlAction(controlStore, {
        action: "abort",
        scope: "run",
        actor,
        runId,
        ...(reason ? { reason } : {}),
      });
      if (!flagged.ok) {
        return flagged.status === "invalid"
          ? badRequest(flagged.error)
          : unavailable();
      }
    } else {
      const recorded = await controlStore.appendEvent(
        toControlEvent({
          at: new Date().toISOString(),
          actor,
          action: "retry",
          scope: "run",
          runId,
          ...(reason ? { reason } : {}),
        }),
      );
      if (!recorded.ok) return unavailable();
    }

    const result = await performOperatorRunAction(
      {
        runHistory,
        dispatch: runDarkFactoryDispatch,
        labels: createGitHubLabelWriter(),
        env: process.env,
      },
      { action, runId, actor, ...(reason ? { reason } : {}) },
    );
    if (result.status === "unavailable") return unavailable();
    // A refusal is the operator's business to see, so it is a 4xx with the reason.
    if (!result.ok) return badRequest(result.reason);
    return okJson({
      status: result.status,
      ...(result.runId ? { runId: result.runId } : {}),
    });
  } catch {
    return unavailable();
  } finally {
    await Promise.all([controlStore?.close?.(), runHistory?.close?.()]);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await guardOperator(request);
  if (!guard.ok) return guard.response;

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
  const guard = await guardOperator(request);
  if (!guard.ok) return guard.response;

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
  if (!isAction(raw.action))
    return badRequest("action must be pause, resume, or stop.");
  if (!isScope(raw.scope)) return badRequest("scope must be factory or run.");
  if (raw.runId !== undefined && typeof raw.runId !== "string") {
    return badRequest("runId must be a string.");
  }
  if (raw.reason !== undefined && typeof raw.reason !== "string") {
    return badRequest("reason must be a string.");
  }

  // #307 — retry/abort reach the ledger, not just the control state.
  if (raw.action === "abort" || raw.action === "retry") {
    if (raw.scope !== "run") {
      return badRequest(`'${raw.action}' is only available for an individual run.`);
    }
    if (typeof raw.runId !== "string" || raw.runId.trim() === "") {
      return badRequest("Run-scoped control actions require a runId.");
    }
    return operatorRunAction(
      raw.action,
      guard.viewer.email,
      raw.runId,
      typeof raw.reason === "string" ? raw.reason : undefined,
    );
  }

  let store;
  try {
    store = createControlStore();
    const result = await performControlAction(store, {
      action: raw.action,
      scope: raw.scope,
      actor: guard.viewer.email,
      ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
      ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
    });
    if (!result.ok) {
      return result.status === "invalid"
        ? badRequest(result.error)
        : unavailable();
    }
    return okJson({
      status: result.status,
      state: result.state,
      duplicate: result.duplicate,
    });
  } catch {
    return unavailable();
  } finally {
    await store?.close?.();
  }
}
