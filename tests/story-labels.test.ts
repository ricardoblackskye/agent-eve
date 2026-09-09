import { describe, it, expect } from "vitest";
import {
  TRIGGER_LABEL,
  DONE_LABEL,
  finalizeLabels,
} from "../agent/lib/story-labels";

describe("finalizeLabels", () => {
  it("removes needs-story and adds user-story-added on success", () => {
    const r = finalizeLabels(["needs-story", "bug"], { success: true });
    expect(r.remove).toEqual(["needs-story"]);
    expect(r.add).toEqual(["user-story-added"]);
  });

  it("is a no-op for non-success (clarification) states", () => {
    const r = finalizeLabels(["needs-story"], { success: false });
    expect(r.remove).toEqual([]);
    expect(r.add).toEqual([]);
  });

  it("does not remove unrelated labels", () => {
    const r = finalizeLabels(["bug"], { success: true });
    expect(r.remove).toEqual([]);
  });

  it("exports the trigger label constant", () => {
    expect(TRIGGER_LABEL).toBe("needs-story");
    expect(DONE_LABEL).toBe("user-story-added");
  });
});