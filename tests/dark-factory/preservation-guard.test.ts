import { describe, it, expect } from "vitest";
import {
  assessPreservation,
  MAX_REMOVED_RATIO,
  type PreservationInput,
} from "../../agent/lib/dark-factory/preservation-guard";

/** A file of `n` distinct non-blank lines. */
function fileOf(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

function input(partial: Partial<PreservationInput> & Pick<PreservationInput, "before" | "after">): PreservationInput {
  return {
    path: "app/chat.tsx",
    action: "modify",
    ...partial,
  };
}

describe("preservation guard (#361)", () => {
  it("allows identical content", () => {
    const content = fileOf(40);
    const verdict = assessPreservation(input({ before: content, after: content }));
    expect(verdict.ok).toBe(true);
    expect(verdict.removedLines).toBe(0);
    expect(verdict.removedRatio).toBe(0);
  });

  it("allows an additive change", () => {
    const before = fileOf(40);
    const after = `${before}\nexport const newThing = 1;`;
    const verdict = assessPreservation(input({ before, after }));
    expect(verdict.ok).toBe(true);
    expect(verdict.beforeLines).toBe(40);
    expect(verdict.afterLines).toBe(41);
  });

  it("refuses the change that shipped: a 75-line component replaced by a 15-line stub", () => {
    const before = fileOf(75);
    const after = fileOf(15, "stub");
    const verdict = assessPreservation(input({ before, after }));
    expect(verdict.ok).toBe(false);
    expect(verdict.beforeLines).toBe(75);
    expect(verdict.afterLines).toBe(15);
    expect(verdict.removedLines).toBe(75);
    expect(verdict.removedRatio).toBe(1);
    expect(verdict.reason).toMatch(/75/);
    expect(verdict.reason).toMatch(/replace/);
  });

  it("refuses a same-size rewrite that swaps more than half the lines", () => {
    // The case a net line count would MISS: the file is the same length, but the content is gone.
    const before = fileOf(10);
    const after = fileOf(10, "different");
    const verdict = assessPreservation(input({ before, after }));
    expect(verdict.ok).toBe(false);
    expect(verdict.removedRatio).toBe(1);
  });

  it("allows exactly half the lines to go, and refuses one more", () => {
    // The boundary, both sides. The rule is MORE than half, so exactly half must pass.
    const before = fileOf(20);
    const atLimit = assessPreservation(
      input({ before, after: fileOf(10, "line") }),
    );
    expect(atLimit.removedRatio).toBe(0.5);
    expect(atLimit.removedRatio).toBe(MAX_REMOVED_RATIO);
    expect(atLimit.ok).toBe(true);

    const pastLimit = assessPreservation(
      input({ before: `${before}\nline 21`, after: fileOf(10, "line") }),
    );
    // 11 of 21 gone is ratio 0.523..., just past the limit.
    expect(pastLimit.removedRatio).toBeGreaterThan(MAX_REMOVED_RATIO);
    expect(pastLimit.ok).toBe(false);
  });

  it("treats re-indentation as preservation, not deletion", () => {
    const before = "function a() {\n  return 1;\n}";
    const after = "function a() {\n\t\treturn 1;\n}";
    const verdict = assessPreservation(input({ before, after }));
    expect(verdict.ok).toBe(true);
    expect(verdict.removedLines).toBe(0);
  });

  it("counts repeated lines with duplicates counted", () => {
    const before = "x\nx\ny";
    const after = "x\ny";
    const verdict = assessPreservation(input({ before, after }));
    expect(verdict.removedLines).toBe(1);
  });

  it("sanctions a whole-file replacement only when the plan declares it", () => {
    const verdict = assessPreservation(
      input({ action: "replace", before: fileOf(75), after: fileOf(15, "stub") }),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toMatch(/replace/);
  });

  it("has nothing to preserve when creating a new file", () => {
    const verdict = assessPreservation(
      input({ action: "create", before: "", after: fileOf(15, "stub") }),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.beforeLines).toBe(0);
    expect(verdict.removedRatio).toBe(0);
  });

  it("ignores blank lines, so removing whitespace is not treated as deleting code", () => {
    const before = "a\n\n\nb\n\n";
    const after = "a\nb";
    const verdict = assessPreservation(input({ before, after }));
    expect(verdict.ok).toBe(true);
    expect(verdict.beforeLines).toBe(2);
    expect(verdict.removedLines).toBe(0);
  });
});
