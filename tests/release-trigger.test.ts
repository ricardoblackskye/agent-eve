import { describe, it, expect } from "vitest";
import { isReleaseNotesTrigger } from "../agent/lib/release-trigger";

// #184: the webhook's pull_request branch used to invoke Eve on EVERY PR
// action. Release notes must fire only when a PR is actually merged.
describe("isReleaseNotesTrigger (#184)", () => {
  it("fires only when a PR is merged (closed + merged: true)", () => {
    expect(isReleaseNotesTrigger({ action: "closed", merged: true })).toBe(
      true,
    );
  });

  it("does NOT fire for a PR closed WITHOUT merging", () => {
    expect(isReleaseNotesTrigger({ action: "closed", merged: false })).toBe(
      false,
    );
  });

  it("does NOT fire when the merged flag is absent (fail-safe: absent != merged)", () => {
    expect(isReleaseNotesTrigger({ action: "closed" })).toBe(false);
  });

  it("does NOT fire for any non-close action, even with merged set", () => {
    for (const action of [
      "opened",
      "synchronize",
      "reopened",
      "labeled",
      "edited",
      "assigned",
    ]) {
      expect(isReleaseNotesTrigger({ action, merged: true })).toBe(false);
    }
  });

  it("does NOT fire for non-close actions without a merge", () => {
    expect(isReleaseNotesTrigger({ action: "opened", merged: false })).toBe(
      false,
    );
  });
});
