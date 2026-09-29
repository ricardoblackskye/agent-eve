import { describe, expect, it } from "vitest";
import { Dispatcher, dispatchKey, type DispatchEvent } from "../../agent/lib/dark-factory/dispatch";
import { SqliteStateAdapter } from "../../agent/lib/dark-factory/state";
import type {
  ControlEvent,
  ControlReadResult,
  ControlStore,
  ControlWriteResult,
  FactoryControlState,
  RunControlState,
} from "../../agent/lib/dark-factory/control";

class ControlState implements ControlStore {
  id = "memory";
  factory: FactoryControlState | null = null;
  runs = new Map<string, RunControlState>();
  unavailable = false;
  async readFactory(): Promise<ControlReadResult<FactoryControlState>> {
    return this.unavailable ? { ok: false, mode: "blocked", providerId: this.id, value: null, error: "offline" } : { ok: true, mode: "live", providerId: this.id, value: this.factory };
  }
  async writeFactory(state: FactoryControlState): Promise<ControlWriteResult> { this.factory = state; return { ok: true, mode: "live", providerId: this.id }; }
  async readRun(runId: string): Promise<ControlReadResult<RunControlState>> {
    return this.unavailable ? { ok: false, mode: "blocked", providerId: this.id, value: null, error: "offline" } : { ok: true, mode: "live", providerId: this.id, value: this.runs.get(runId) ?? null };
  }
  async writeRun(runId: string, state: RunControlState): Promise<ControlWriteResult> { this.runs.set(runId, state); return { ok: true, mode: "live", providerId: this.id }; }
  async appendEvent(_event: ControlEvent): Promise<ControlWriteResult> { return { ok: true, mode: "live", providerId: this.id }; }
  async applyChange(): Promise<ControlWriteResult> { return { ok: true, mode: "live", providerId: this.id }; }
  async listEvents(): Promise<ControlReadResult<ControlEvent[]>> { return { ok: true, mode: "live", providerId: this.id, value: [] }; }
}

const event: DispatchEvent = { runId: "run-42", repo: "owner/repo", ref: "main", status: "failure" };
const at = "2026-09-29T10:00:00.000Z";

describe("Dispatcher control gate", () => {
  it("does not persist a factory-paused delivery, so it can run after resume", async () => {
    const state = new SqliteStateAdapter(":memory:");
    const control = new ControlState();
    control.factory = { paused: true, updatedAt: at };
    let handled = 0;
    const dispatcher = new Dispatcher({ store: state, controlStore: control, handler: async () => { handled += 1; }, sleep: async () => {} });

    expect(await dispatcher.dispatch(event)).toMatchObject({ ok: true, status: "paused", gate: "factory" });
    expect((await state.get(dispatchKey(event.runId))).value).toBeNull();
    control.factory = { paused: false, updatedAt: at };
    expect((await dispatcher.dispatch(event)).status).toBe("succeeded");
    expect(handled).toBe(1);
    state.close();
  });

  it("refuses work when the control store is unavailable", async () => {
    const state = new SqliteStateAdapter(":memory:");
    const control = new ControlState();
    control.unavailable = true;
    let handled = 0;
    const dispatcher = new Dispatcher({ store: state, controlStore: control, handler: async () => { handled += 1; }, sleep: async () => {} });
    expect(await dispatcher.dispatch(event)).toMatchObject({ ok: true, status: "paused", gate: "unavailable" });
    expect((await state.get(dispatchKey(event.runId))).value).toBeNull();
    expect(handled).toBe(0);
    state.close();
  });

  it("refuses run-paused and run-stopped deliveries", async () => {
    const state = new SqliteStateAdapter(":memory:");
    const control = new ControlState();
    control.runs.set(event.runId, { paused: true, stopped: false, updatedAt: at });
    const dispatcher = new Dispatcher({ store: state, controlStore: control, handler: async () => {}, sleep: async () => {} });
    expect(await dispatcher.dispatch(event)).toMatchObject({ status: "paused", gate: "run" });
    control.runs.set(event.runId, { paused: false, stopped: true, updatedAt: at });
    expect(await dispatcher.dispatch(event)).toMatchObject({ status: "stopped", gate: "run" });
    state.close();
  });

  it("pauses at an in-flight checkpoint and resumes the saved delivery", async () => {
    const state = new SqliteStateAdapter(":memory:");
    const control = new ControlState();
    let handled = 0;
    const dispatcher = new Dispatcher({
      store: state,
      controlStore: control,
      sleep: async () => {},
      handler: async (_event, _worker, checkpoint) => {
        handled += 1;
        if (handled === 1) {
          control.runs.set(event.runId, { paused: true, stopped: false, updatedAt: at });
          await checkpoint();
        }
      },
    });

    expect(await dispatcher.dispatch(event)).toMatchObject({ ok: true, status: "paused", gate: "run" });
    expect((await state.get<{ status: string }>(dispatchKey(event.runId))).value?.status).toBe("paused");
    control.runs.set(event.runId, { paused: false, stopped: false, updatedAt: at });
    expect((await dispatcher.dispatch(event)).status).toBe("succeeded");
    expect(handled).toBe(2);
    state.close();
  });
});
