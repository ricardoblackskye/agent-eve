import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Dark Factory's labels have ONE definition (#348 R2).
 *
 * `trigger.ts` owns the spelling, and `definition-of-done.ts` already imports `TRIGGER_LABELS` for the
 * terminal labels - but three call sites still repeated `"needs-answer"` as a literal. That is not a bug
 * today; it is a rename away from becoming one, silently, in the places that park a run for a human.
 */
describe("the Dark Factory labels have one definition", () => {
  const source = readFileSync("agent/lib/dark-factory/definition-of-done.ts", "utf8");

  it("uses TRIGGER_LABELS instead of repeating the spelling", () => {
    expect(source).not.toContain('"needs-answer"');
    expect(source).toContain("TRIGGER_LABELS.question");
  });
});
