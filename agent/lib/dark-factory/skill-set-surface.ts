/**
 * Dark Factory — the skill-set tunable surface (#157).
 *
 * The concrete surface that #146 AC8 only *seamed*: a real `TunableSurface` whose
 * value is the set of enabled skills, persisted through the `StateStore` so that a
 * restart does not forget it.
 *
 * Two constraints come straight from the interfaces it must satisfy:
 *
 * - `TunableSurface.read()` is **synchronous**, so the store cannot be read on
 *   every call: `createSkillSetSurface` loads the snapshot once (async) and caches
 *   it. That is why this is a factory rather than a constructor.
 * - `VersionHandle` requires `previous`/`next` and an **idempotent** `revert()`,
 *   plus the superseded-handle guard `IterationBoundSurface` established: a stale
 *   handle must not be able to silently undo a newer change.
 *
 * Widening capability is the gated class: adding a skill is `access-widening`, so
 * the controller cannot apply it without an armed operator decision (#159's CLI is
 * how one is armed).
 */

import {
  makeProposal,
  SupersededVersionError,
  type Proposal,
  type TunableSurface,
  type VersionHandle,
} from "./self-improve";
import { SelfImprovementStateError } from "./self-improve-state";
import { canonicaliseSkills, type SkillName } from "./skills";
import type { StateStore } from "./state";

/** One key, one JSON array — the same adapter pattern as the R4b decision store. */
const SKILLS_KEY = "self-improve:skills";
const SURFACE_ID = "skill-set";

export type SkillSet = readonly SkillName[];

export interface SkillSetSurface extends TunableSurface<SkillSet> {
  readonly id: string;
  read(): SkillSet;
  stage(next: SkillSet): Promise<VersionHandle<SkillSet>>;
}

export interface SkillEvidence {
  taskType: string;
  observedSuccessRate: number;
  samples: number;
}

/**
 * Build the surface over a store, loading its snapshot once.
 *
 * A stored name the catalogue no longer knows is **dropped and rewritten**, never
 * honoured: if a skill is retired from the code, the store must not keep granting
 * it. Dropping narrows capability, which is the fail-closed direction.
 */
export async function createSkillSetSurface(
  store: StateStore,
): Promise<SkillSetSurface> {
  const readStored = async (): Promise<{ kept: string[]; raw: unknown }> => {
    const result = await store.get<unknown>(SKILLS_KEY);
    // An unreadable store yields the empty set (the defaults), never a throw:
    // the factory must still boot, and empty means "no widening".
    if (!result.ok || !Array.isArray(result.value))
      return { kept: [], raw: null };
    const kept: string[] = [];
    for (const entry of result.value) {
      if (typeof entry !== "string") continue;
      try {
        kept.push(canonicaliseSkills([entry])[0]);
      } catch {
        // Retired or unknown skill: drop it rather than honour it.
      }
    }
    return { kept, raw: result.value };
  };

  const first = await readStored();
  let current: SkillSet = canonicaliseSkills(first.kept);
  if (
    first.raw !== null &&
    JSON.stringify(first.raw) !== JSON.stringify(current)
  ) {
    // Only rewrite when there WAS a stored set to narrow: a fresh store must not
    // be written to on construction (it would also make the surface depend on a
    // writable store just to be read).
    await persist(current);
  }
  let version = 1;

  async function persist(skills: SkillSet): Promise<void> {
    const result = await store.save(SKILLS_KEY, skills);
    if (!result.ok) {
      // Never let a caller believe a grant was recorded when it was not — the
      // failure #159's CLI made explicit, and it applies equally here.
      throw new SelfImprovementStateError(
        `Could not persist the skill set via '${store.id}' (${result.error ?? result.mode}).`,
      );
    }
  }

  return {
    id: SURFACE_ID,

    read(): SkillSet {
      return current;
    },

    async stage(next: SkillSet): Promise<VersionHandle<SkillSet>> {
      // Throws SkillCatalogueError for an unknown name: staging a skill the
      // catalogue does not define would widen capability with nothing behind it.
      const canonical = canonicaliseSkills(next);
      const previous = current;
      const previousVersion = `${SURFACE_ID}@v${version}`;
      version += 1;
      const id = `${SURFACE_ID}@v${version}`;
      const handleVersion = version;
      let applied = false;

      const assertCurrent = (): void => {
        if (version !== handleVersion) {
          throw new SupersededVersionError(
            `Handle '${id}' was superseded by '${SURFACE_ID}@v${version}'; ` +
              "refusing to act on a stale version.",
          );
        }
      };

      return {
        id,
        surfaceId: SURFACE_ID,
        previousVersion,
        previous,
        next: canonical,
        async apply(): Promise<void> {
          assertCurrent();
          await persist(canonical);
          current = canonical;
          applied = true;
        },
        async revert(): Promise<void> {
          assertCurrent();
          if (!applied) return; // idempotent: reverting twice is not an error
          await persist(previous);
          current = previous;
          applied = false;
        },
        isApplied: (): boolean => applied,
      };
    },
  };
}

/**
 * Propose adding one skill to the current set.
 *
 * The factory does not discover skills (that is deliberately out of scope): an
 * operator names the skill, and this supplies the mechanics — the widened set and
 * the written causal hypothesis the ledger requires.
 */
export function proposeSkillAddition(
  surface: SkillSetSurface,
  skill: string,
  evidence: SkillEvidence,
): Proposal {
  const current = surface.read();
  const next = canonicaliseSkills([...current, skill]);
  return makeProposal({
    surfaceId: surface.id,
    next,
    kind: "access-widening",
    hypothesis:
      `Granting the '${skill}' skill to the '${surface.id}' surface for task type ` +
      `'${evidence.taskType}' (observed success rate ${evidence.observedSuccessRate} over ` +
      `${evidence.samples} samples) should lift the objective by widening what the agent ` +
      `is allowed to produce, from ${current.length} to ${next.length} skills.`,
  });
}
