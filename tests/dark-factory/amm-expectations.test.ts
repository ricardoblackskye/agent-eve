/**
 * #426 AC1 - every catalogue row carries a machine-checkable expectation.
 *
 * `expected` is prose today ("the linter runs and reports no errors"). A runner cannot execute prose: without this
 * change it would have to invent an interpretation of all 39 rows, and every interpretation would be a silent
 * design decision living in the runner instead of in the catalogue.
 *
 * This guard is the one AC1 asks for. It is its own file rather than an addition to `amm-scoring.test.ts` because it
 * checks the SHAPE of the catalogue, not the arithmetic of the scorer - and because `amm-scoring.test.ts` must not
 * change meaning when the vocabulary grows.
 *
 * The rows are read through a local shape rather than the exported type: the point of the guard is to assert that
 * fields exist, and a field that does not yet exist cannot be named by the type that omits it.
 */
import { describe, expect, it } from "vitest";

import { AMM_SIGNAL_CATALOGUE } from "../../agent/lib/dark-factory/amm-signals";

/** Kinds the runner can evaluate. A kind outside this list must fail HERE rather than at runtime in the runner. */
const VOCABULARY = ["exists", "contains", "exitCode"];

/** Which expectation kinds a check of each kind can actually produce. */
const COMPATIBLE: Record<string, readonly string[]> = {
  file: ["exists", "contains"],
  command: ["exitCode"],
};

interface GuardedRow {
  id: string;
  label: string;
  check: { kind: string; path?: string; command?: string };
  expectation?: { kind: string; text?: string; code?: number; withinMs?: number };
  weak?: string;
  /** The prose field this change removes. Its presence means the migration is incomplete. */
  expected?: string;
}

const rows = AMM_SIGNAL_CATALOGUE as unknown as readonly GuardedRow[];

describe("#426 every catalogue row carries a machine-checkable expectation", () => {
  it("has one on every row, and no prose `expected` left behind", () => {
    const offenders = rows
      .filter((row) => row.expectation === undefined || row.expected !== undefined)
      .map((row) => row.id);

    expect(offenders).toEqual([]);
  });

  it("uses only kinds the runner knows how to evaluate", () => {
    const unknown = rows
      .filter((row) => !VOCABULARY.includes(row.expectation?.kind ?? ""))
      .map((row) => `${row.id} -> ${row.expectation?.kind ?? "none"}`);

    expect(unknown).toEqual([]);
  });

  it("pairs every expectation with a check kind that can evaluate it", () => {
    const mismatched = rows
      .filter((row) => !(COMPATIBLE[row.check.kind] ?? []).includes(row.expectation?.kind ?? ""))
      .map((row) => `${row.id}: ${row.check.kind} check, ${row.expectation?.kind} expectation`);

    expect(mismatched).toEqual([]);
  });

  it("carries a time bound where the time IS the signal", () => {
    for (const id of ["fast-validation", "fast-suite"]) {
      const row = rows.find((entry) => entry.id === id);
      expect(row, `${id} must exist`).toBeDefined();
      expect(row?.expectation?.kind, `${id} must be a command expectation`).toBe("exitCode");
      // Without the bound this row reports PRESENT on a ten-minute run, which is the opposite of its label.
      expect(
        row?.expectation?.withinMs ?? 0,
        `${id} claims a time bound, so a bare exit code would not test what its label says`,
      ).toBeGreaterThan(0);
    }
  });

  it("gives a reason wherever a check proves less than its label claims", () => {
    const weak = rows.filter((row) => row.weak !== undefined);

    expect(weak.length, "the narrowed rows must be marked, not left silently over-claiming").toBeGreaterThan(0);
    for (const row of weak) {
      expect(
        (row.weak ?? "").trim().length,
        `${row.id} is marked weak without saying why`,
      ).toBeGreaterThan(10);
    }
  });
});