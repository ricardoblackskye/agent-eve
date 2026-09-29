import { describe, expect, it } from "vitest";
import {
  SqliteControlAdapter,
  type ControlEvent,
  type ControlReadResult,
  type ControlStore,
  type ControlWriteResult,
  type FactoryControlState,
  type RunControlState,
} from "../../agent/lib/dark-factory/control";
import { performControlAction } from "../../agent/lib/dark-factory/control-service";

class MemoryControlStore implements ControlStore {
  id = "memory";
  factory: FactoryControlState | null = null;
  runs = new Map<string, RunControlState>();
  events: ControlEvent[] = [];
  failReads = false;
  async readFactory(): Promise<ControlReadResult<FactoryControlState>> {
    return this.failReads ? { ok: false, mode: "blocked", providerId: this.id, value: null, error: "offline" } : { ok: true, mode: "live", providerId: this.id, value: this.factory };
  }
  async writeFactory(state: FactoryControlState): Promise<ControlWriteResult> {
    this.factory = state;
    return { ok: true, mode: "live", providerId: this.id };
  }
  async readRun(runId: string): Promise<ControlReadResult<RunControlState>> {
    return this.failReads ? { ok: false, mode: "blocked", providerId: this.id, value: null, error: "offline" } : { ok: true, mode: "live", providerId: this.id, value: this.runs.get(runId) ?? null };
  }
  async writeRun(runId: string, state: RunControlState): Promise<ControlWriteResult> {
    this.runs.set(runId, state);
    return { ok: true, mode: "live", providerId: this.id };
  }
  async appendEvent(event: ControlEvent): Promise<ControlWriteResult> {
    this.events.push(event);
    return { ok: true, mode: "live", providerId: this.id };
  }
  async applyChange(change: { event: ControlEvent; factoryState?: FactoryControlState; runId?: string; runState?: RunControlState }): Promise<ControlWriteResult> {
    if (change.factoryState) this.factory = change.factoryState;
    if (change.runId && change.runState) this.runs.set(change.runId, change.runState);
    this.events.push(change.event);
    return { ok: true, mode: "live", providerId: this.id };
  }
  async listEvents(): Promise<ControlReadResult<ControlEvent[]>> {
    return { ok: true, mode: "live", providerId: this.id, value: [...this.events] };
  }
}

const time = "2026-09-29T10:00:00.000Z";

class TwoReaderBarrierStore extends SqliteControlAdapter {
  private reads = 0;
  private release!: () => void;
  private readonly barrier = new Promise<void>((resolve) => { this.release = resolve; });

  override async readRun(runId: string) {
    const snapshot = await super.readRun(runId);
    this.reads += 1;
    if (this.reads === 2) this.release();
    if (this.reads <= 2) await this.barrier;
    return snapshot;
  }
}

describe("performControlAction", () => {
  it("pauses the factory and appends an auditable event", async () => {
    const store = new MemoryControlStore();
    const result = await performControlAction(store, { action: "pause", scope: "factory", actor: "operator@example.test", reason: "incident", now: () => time });
    expect(result).toMatchObject({ ok: true, state: { paused: true, actor: "operator@example.test" } });
    expect(store.events).toEqual([{ at: time, actor: "operator@example.test", action: "pause", scope: "factory", reason: "incident" }]);
  });

  it("pauses and resumes a run, but Stop is terminal and cannot be resumed", async () => {
    const store = new MemoryControlStore();
    const common = { scope: "run" as const, runId: "run-42", actor: "operator", now: () => time };
    const pauseResult = await performControlAction(store, { ...common, action: "pause" });
    expect(pauseResult.ok).toBe(true);
    expect(store.runs.get("run-42")?.paused).toBe(true);
    expect((await performControlAction(store, { ...common, action: "resume" })).ok).toBe(true);
    expect(store.runs.get("run-42")?.paused).toBe(false);
    expect((await performControlAction(store, { ...common, action: "stop" })).ok).toBe(true);
    expect(store.runs.get("run-42")?.stopped).toBe(true);
    const eventCount = store.events.length;
    expect(await performControlAction(store, { ...common, action: "stop" })).toMatchObject({ ok: true, duplicate: true });
    expect((await performControlAction(store, { ...common, action: "resume" })).status).toBe("invalid");
    expect(store.events).toHaveLength(eventCount);
  });

  it("keeps Stop terminal when pause and Stop race from the same snapshot", async () => {
    const store = new TwoReaderBarrierStore(":memory:");
    const common = { scope: "run" as const, runId: "run-race", actor: "operator", now: () => time };
    const [pause, stop] = await Promise.all([
      performControlAction(store, { ...common, action: "pause" }),
      performControlAction(store, { ...common, action: "stop" }),
    ]);
    const state = await store.readRun("run-race");
    const events = await store.listEvents();
    expect(stop.ok).toBe(true);
    expect(state.value).toMatchObject({ paused: false, stopped: true });
    expect(events.value?.filter((event) => event.action === "stop")).toHaveLength(1);
    const actions = events.value?.map((event) => event.action);
    expect(actions).toEqual(pause.ok ? ["stop", "pause"] : ["stop"]);
    store.close();
  });

  it("writes only one audit event for concurrent identical actions", async () => {
    const store = new TwoReaderBarrierStore(":memory:");
    const input = { scope: "run" as const, runId: "run-duplicate", actor: "operator", action: "pause" as const, now: () => time };
    const results = await Promise.all([
      performControlAction(store, input),
      performControlAction(store, input),
    ]);
    const events = await store.listEvents();
    expect(results.every((result) => result.ok)).toBe(true);
    expect(events.value).toHaveLength(1);
    store.close();
  });

  it("fails closed when current state cannot be read", async () => {
    const store = new MemoryControlStore();
    store.failReads = true;
    expect(await performControlAction(store, { action: "pause", scope: "factory", actor: "operator", now: () => time })).toMatchObject({ ok: false, status: "unavailable" });
    expect(store.events).toHaveLength(0);
  });

  it("rejects Stop at factory scope", async () => {
    const store = new MemoryControlStore();
    expect(await performControlAction(store, { action: "stop", scope: "factory", actor: "operator", now: () => time })).toMatchObject({ ok: false, status: "invalid" });
  });
});
