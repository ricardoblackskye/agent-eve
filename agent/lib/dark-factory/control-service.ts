import {
  InvalidControlError,
  toControlEvent,
  validateControlActor,
  validateControlReason,
  validateControlRunId,
  type ControlAction,
  type ControlChange,
  type ControlEvent,
  type ControlScope,
  type ControlStore,
  type FactoryControlState,
  type RunControlState,
} from "./control";

export interface ControlActionInput {
  action: ControlAction;
  scope: ControlScope;
  actor: string;
  runId?: string;
  reason?: string;
  now?: () => string;
}

export type ControlActionResult =
  | { ok: true; status: "applied"; state: FactoryControlState | RunControlState; event: ControlEvent; duplicate?: boolean }
  | { ok: false; status: "invalid" | "unavailable"; error: string };

function unavailable(error?: string): ControlActionResult {
  return {
    ok: false,
    status: "unavailable",
    error: error ?? "Control state is unavailable; refusing the action.",
  };
}

export async function performControlAction(
  store: ControlStore,
  input: ControlActionInput,
): Promise<ControlActionResult> {
  try {
    const actor = validateControlActor(input.actor);
    const reason = validateControlReason(input.reason);
    const runId = input.runId ? validateControlRunId(input.runId) : undefined;
    if (input.scope === "factory" && input.action === "stop") {
      throw new InvalidControlError("Stop is only available for an individual run.");
    }
    if (input.scope === "run" && !runId) {
      throw new InvalidControlError("Run-scoped control actions require a runId.");
    }
    if (input.scope === "factory" && runId) {
      throw new InvalidControlError("Factory-scoped control actions cannot include a runId.");
    }

    const now = (input.now ?? (() => new Date().toISOString()))();
    const event = toControlEvent({
      at: now,
      actor,
      action: input.action,
      scope: input.scope,
      ...(runId ? { runId } : {}),
      ...(reason ? { reason } : {}),
    });

    let change: ControlChange;
    let state: FactoryControlState | RunControlState;
    if (input.scope === "factory") {
      const current = await store.readFactory();
      if (!current.ok) return unavailable(current.error);
      const paused = input.action === "pause";
      state = {
        paused,
        updatedAt: now,
        actor,
        ...(reason ? { reason } : {}),
      };
      if (current.value?.paused === paused) {
        return { ok: true, status: "applied", state: current.value, event, duplicate: true };
      }
      change = { event, factoryState: state as FactoryControlState };
    } else {
      const current = await store.readRun(runId!);
      if (!current.ok) return unavailable(current.error);
      const previous = current.value;
      if (previous?.stopped) {
        if (input.action === "stop") {
          return { ok: true, status: "applied", state: previous, event, duplicate: true };
        }
        return { ok: false, status: "invalid", error: "A stopped run cannot be paused or resumed." };
      }
      const paused = input.action === "pause";
      const stopped = input.action === "stop";
      state = {
        paused: stopped ? false : paused,
        stopped,
        updatedAt: now,
        actor,
        ...(reason ? { reason } : {}),
      };
      if (previous && previous.paused === state.paused && previous.stopped === state.stopped) {
        return { ok: true, status: "applied", state: previous, event, duplicate: true };
      }
      change = { event, runId, runState: state as RunControlState };
    }

    let written;
    try {
      written = await store.applyChange(change);
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error));
    }
    if (!written.ok) return unavailable(written.error);
    return { ok: true, status: "applied", state, event };
  } catch (error) {
    return {
      ok: false,
      status: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
