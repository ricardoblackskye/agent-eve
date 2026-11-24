import { describe, expect, it } from "vitest";

import { selectCheckoutBase } from "../../agent/lib/dark-factory/runner-config";

/**
 * #744. A re-run must start from the branch the first run pushed, never blindly from main, and it
 * must never force-push. The input is stated, so the choice is provable without a sandbox.
 */
const DEFAULT_BASE = "main";

describe("the sandbox checkout base (#744)", () => {
  it("starts from the existing DF branch, so a re-run can push", () => {
    const result = selectCheckoutBase({
      branch: "feat/dark-factory-256",
      remoteBranchExists: true,
      defaultBase: DEFAULT_BASE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.base).toBe("feat/dark-factory-256");
    expect(result.source).toBe("remote-branch");
  });

  // The control: a change that always checks out a branch must fail this.
  it("starts from the default branch when no DF branch exists", () => {
    const result = selectCheckoutBase({
      branch: "feat/dark-factory-256",
      remoteBranchExists: false,
      defaultBase: DEFAULT_BASE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.base).toBe(DEFAULT_BASE);
    expect(result.source).toBe("default");
  });

  it("refuses a blank branch name rather than checking it out", () => {
    const result = selectCheckoutBase({ branch: "   ", remoteBranchExists: true, defaultBase: DEFAULT_BASE });
    expect(result.ok).toBe(false);
  });

  it("refuses a branch name carrying a hash, which git cannot take", () => {
    const result = selectCheckoutBase({ branch: "feat/dark-factory-#256", remoteBranchExists: true, defaultBase: DEFAULT_BASE });
    expect(result.ok).toBe(false);
  });

  it("uses whatever default it is given, so nothing here is repo-specific", () => {
    const result = selectCheckoutBase({ branch: "feat/dark-factory-1", remoteBranchExists: false, defaultBase: "trunk" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.base).toBe("trunk");
  });
});
