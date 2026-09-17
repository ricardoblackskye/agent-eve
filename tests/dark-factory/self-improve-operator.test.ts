import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOperatorDecisionStore,
  createCadenceWatermark,
  operatorGateFromStore,
  SelfImprovementStateError,
  type OperatorDecision,
} from "../../agent/lib/dark-factory/self-improve-state";
import {
  ConsoleStateProvider,
  SqliteStateAdapter,
} from "../../agent/lib/dark-factory/state";
import type { Proposal } from "../../agent/lib/dark-factory/self-improve";

// A REAL StateStore (the seam this ships against), not a hand-rolled fake.
const dirs: string[] = [];
const stores: SqliteStateAdapter[] = [];

function realStore(): SqliteStateAdapter {
  const dir = mkdtempSync(join(tmpdir(), "df-operator-"));
  dirs.push(dir);
  const store = new SqliteStateAdapter(join(dir, "state.sqlite"));
  stores.push(store);
  return store;
}

afterEach(() => {
  // A file-backed adapter MUST be closed first: an open handle locks the file on
  // Windows and the rmSync below would fail with EBUSY.
  for (const store of stores.splice(0)) store.close?.();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function decision(overrides: Partial<OperatorDecision> = {}): OperatorDecision {
  return {
    surfaceId: "iteration-bound",
    kind: "access-widening",
    decision: "allow",
    decidedBy: "ops@example.com",
    decidedAt: "2026-09-17T00:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

const proposal: Proposal = {
  surfaceId: "iteration-bound",
  next: 12,
  hypothesis: "widen access for the worker",
  kind: "access-widening",
};

describe("createOperatorDecisionStore (#146 R4b)", () => {
  it("round-trips a decision through the real state store", async () => {
    const store = createOperatorDecisionStore(realStore());

    await store.record(decision());

    expect(await store.get("iteration-bound", "access-widening")).toEqual(
      decision(),
    );
  });

  it("returns null when nothing is recorded, and after a clear", async () => {
    const store = createOperatorDecisionStore(realStore());

    expect(await store.get("iteration-bound", "access-widening")).toBeNull();

    await store.record(decision());
    await store.clear("iteration-bound", "access-widening");

    expect(await store.get("iteration-bound", "access-widening")).toBeNull();
  });

  it("upserts rather than accumulating duplicates for the same pair", async () => {
    const store = createOperatorDecisionStore(realStore());

    await store.record(decision({ decision: "allow" }));
    await store.record(decision({ decision: "deny" }));

    const live = await store.get("iteration-bound", "access-widening");
    expect(live?.decision).toBe("deny");
    expect(await store.list()).toHaveLength(1);
  });

  it("treats an expired decision as absent", async () => {
    const store = createOperatorDecisionStore(realStore());
    await store.record(decision({ expiresAt: "2026-09-17T01:00:00.000Z" }));

    expect(
      await store.get(
        "iteration-bound",
        "access-widening",
        () => new Date("2026-09-17T00:30:00.000Z"),
      ),
    ).not.toBeNull();
    expect(
      await store.get(
        "iteration-bound",
        "access-widening",
        () => new Date("2026-09-17T02:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("lists every recorded decision", async () => {
    const store = createOperatorDecisionStore(realStore());

    await store.record(decision());
    await store.record(
      decision({ surfaceId: "skill-set", kind: "bounded-tuning" }),
    );

    expect(await store.list()).toHaveLength(2);
  });

  it("surfaces a refused write instead of pretending the decision was armed", async () => {
    // ConsoleStateProvider is the fail-closed default: it refuses every write.
    const store = createOperatorDecisionStore(new ConsoleStateProvider());

    await expect(store.record(decision())).rejects.toThrow(
      SelfImprovementStateError,
    );
  });
});

describe("operatorGateFromStore (#146 R4b)", () => {
  it("allows when a live decision says allow", async () => {
    const store = createOperatorDecisionStore(realStore());
    await store.record(decision({ decision: "allow" }));

    const gate = operatorGateFromStore(store);

    expect(await gate.approve(proposal)).toBe(true);
  });

  it("refuses when the decision says deny", async () => {
    const store = createOperatorDecisionStore(realStore());
    await store.record(decision({ decision: "deny" }));

    const gate = operatorGateFromStore(store);

    expect(await gate.approve(proposal)).toBe(false);
  });

  it("refuses when nothing has been recorded (fail-closed)", async () => {
    const gate = operatorGateFromStore(
      createOperatorDecisionStore(realStore()),
    );

    expect(await gate.approve(proposal)).toBe(false);
  });

  it("refuses once the decision has expired", async () => {
    const store = createOperatorDecisionStore(realStore());
    await store.record(
      decision({ decision: "allow", expiresAt: "2026-09-17T01:00:00.000Z" }),
    );
    const gate = operatorGateFromStore(
      store,
      () => new Date("2026-09-17T02:00:00.000Z"),
    );

    expect(await gate.approve(proposal)).toBe(false);
  });

  it("allows before the expiry instant", async () => {
    const store = createOperatorDecisionStore(realStore());
    await store.record(
      decision({ decision: "allow", expiresAt: "2026-09-17T01:00:00.000Z" }),
    );
    const gate = operatorGateFromStore(
      store,
      () => new Date("2026-09-17T00:30:00.000Z"),
    );

    expect(await gate.approve(proposal)).toBe(true);
  });

  it("scopes a decision to its surface and kind", async () => {
    const store = createOperatorDecisionStore(realStore());
    await store.record(
      decision({ surfaceId: "skill-set", kind: "bounded-tuning" }),
    );

    const gate = operatorGateFromStore(store);

    expect(await gate.approve(proposal)).toBe(false);
  });
});

describe("createCadenceWatermark (#146 R4b)", () => {
  it("reads null before anything is written, then the written value", async () => {
    const watermark = createCadenceWatermark(realStore());

    expect(await watermark.read()).toBeNull();

    await watermark.write("2026-09-17T12:00:00.000Z");

    expect(await watermark.read()).toBe("2026-09-17T12:00:00.000Z");
  });

  it("survives a new adapter over the same store (durable, not in-process)", async () => {
    const store = realStore();
    await createCadenceWatermark(store).write("2026-09-17T12:00:00.000Z");

    expect(await createCadenceWatermark(store).read()).toBe(
      "2026-09-17T12:00:00.000Z",
    );
  });
});
