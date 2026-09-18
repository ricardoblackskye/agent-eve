import { describe, it, expect } from "vitest";
import {
  createSkillSetSurface,
  proposeSkillAddition,
  type SkillSet,
} from "../../agent/lib/dark-factory/skill-set-surface";
import { SupersededVersionError } from "../../agent/lib/dark-factory/self-improve";
import { SelfImprovementStateError } from "../../agent/lib/dark-factory/self-improve-state";
import { SkillCatalogueError } from "../../agent/lib/dark-factory/skills";
import type { StateStore } from "../../agent/lib/dark-factory/state";

/**
 * #157 — the store-backed skill-set surface.
 *
 * `TunableSurface.read()` is SYNCHRONOUS, so the surface cannot read the store on
 * every call: an async factory loads the snapshot once and caches it. These tests
 * pin that, the versioning contract (a superseded handle must not act), and the
 * rule that a store which refuses to persist never looks like a success.
 */

function memoryStore(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const store: StateStore = {
    id: "memory",
    async save(key: string, value: unknown) {
      data[key] = value;
      return { ok: true, mode: "live", providerId: "memory" };
    },
    async get<T>(key: string) {
      return {
        ok: true,
        mode: "live",
        providerId: "memory",
        value: (key in data ? data[key] : null) as T,
      };
    },
  } as StateStore;
  return { store, data };
}

function refusingStore(): StateStore {
  return {
    id: "console",
    async save(key: string) {
      return {
        ok: false,
        mode: "blocked",
        providerId: "console",
        error: `Refusing to write '${key}'.`,
      };
    },
    async get() {
      return { ok: false, mode: "blocked", providerId: "console", value: null };
    },
  } as unknown as StateStore;
}

const KEY = "self-improve:skills";

describe("SkillSetSurface (#157)", () => {
  it("reads an empty set from a fresh store", async () => {
    const { store } = memoryStore();
    const surface = await createSkillSetSurface(store);
    expect(surface.id).toBe("skill-set");
    expect(surface.read()).toEqual([]);
  });

  it("refuses an unknown skill at stage() and persists nothing", async () => {
    const { store, data } = memoryStore();
    const surface = await createSkillSetSurface(store);
    await expect(
      surface.stage(["teleportation"] as unknown as SkillSet),
    ).rejects.toThrow(/teleportation/);
    expect(data[KEY]).toBeUndefined();
  });

  it("canonicalises what it stages", async () => {
    const { store } = memoryStore();
    const surface = await createSkillSetSurface(store);
    const handle = await surface.stage([
      "shell-automation",
      "database-migration",
      "shell-automation",
    ] as SkillSet);
    expect(handle.next).toEqual(["database-migration", "shell-automation"]);
  });

  it("apply() persists, and a NEW surface over the same store reads it back", async () => {
    const { store } = memoryStore();
    const surface = await createSkillSetSurface(store);
    const handle = await surface.stage(["database-migration"] as SkillSet);
    await handle.apply();

    expect(handle.isApplied()).toBe(true);
    const reopened = await createSkillSetSurface(store);
    expect(reopened.read()).toEqual(["database-migration"]);
  });

  it("revert() restores the previous set, is idempotent, and flips isApplied", async () => {
    const { store } = memoryStore();
    const surface = await createSkillSetSurface(store);
    const handle = await surface.stage(["database-migration"] as SkillSet);
    await handle.apply();
    await handle.revert();

    expect(handle.isApplied()).toBe(false);
    expect(surface.read()).toEqual([]);
    await handle.revert(); // idempotent — no throw, no change
    expect(surface.read()).toEqual([]);
    const reopened = await createSkillSetSurface(store);
    expect(reopened.read()).toEqual([]);
  });

  it("refuses to act on a superseded handle", async () => {
    const { store } = memoryStore();
    const surface = await createSkillSetSurface(store);
    const first = await surface.stage(["database-migration"] as SkillSet);
    await surface.stage(["shell-automation"] as SkillSet);

    await expect(first.apply()).rejects.toThrow(SupersededVersionError);
    await expect(first.revert()).rejects.toThrow(SupersededVersionError);
  });

  it("never reports success when the store refuses to persist", async () => {
    const surface = await createSkillSetSurface(refusingStore());
    const handle = await surface.stage(["database-migration"] as SkillSet);

    await expect(handle.apply()).rejects.toThrow(SelfImprovementStateError);
    expect(handle.isApplied()).toBe(false);
  });

  it("DROPS a stored name the catalogue no longer knows (narrowing, never honouring)", async () => {
    const { store, data } = memoryStore({
      [KEY]: ["database-migration", "retired-skill"],
    });
    const surface = await createSkillSetSurface(store);

    expect(surface.read()).toEqual(["database-migration"]);
    expect(data[KEY]).toEqual(["database-migration"]); // rewritten without the unknown name
  });

  it("treats an unreadable store as an empty set rather than throwing", async () => {
    const surface = await createSkillSetSurface(refusingStore());
    expect(surface.read()).toEqual([]);
  });
});

describe("proposeSkillAddition (#157)", () => {
  it("produces an access-widening proposal with a written hypothesis", async () => {
    const { store } = memoryStore();
    const surface = await createSkillSetSurface(store);
    const proposal = proposeSkillAddition(surface, "database-migration", {
      taskType: "coding",
      observedSuccessRate: 0.6,
      samples: 30,
    });

    // Widening capability is never a "bounded-tuning": it is the gated class.
    expect(proposal.kind).toBe("access-widening");
    expect(proposal.surfaceId).toBe("skill-set");
    expect(proposal.next).toEqual(["database-migration"]);
    expect(proposal.hypothesis).toMatch(/database-migration/);
    expect(proposal.hypothesis.trim().length).toBeGreaterThan(0);
  });

  it("adds to the current set rather than replacing it", async () => {
    const { store } = memoryStore();
    const surface = await createSkillSetSurface(store);
    const first = await surface.stage(["database-migration"] as SkillSet);
    await first.apply();

    const proposal = proposeSkillAddition(surface, "shell-automation", {
      taskType: "coding",
      observedSuccessRate: 0.5,
      samples: 20,
    });
    expect(proposal.next).toEqual(["database-migration", "shell-automation"]);
  });

  it("refuses an unknown skill instead of proposing it", async () => {
    const { store } = memoryStore();
    const surface = await createSkillSetSurface(store);
    expect(() =>
      proposeSkillAddition(surface, "teleportation", {
        taskType: "coding",
        observedSuccessRate: 0.5,
        samples: 20,
      }),
    ).toThrow(SkillCatalogueError);
  });
});
