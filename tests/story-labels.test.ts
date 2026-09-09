import { describe, it, expect } from "vitest";
import {
  TRIGGER_LABEL,
  DONE_LABEL,
  finalizeLabels,
} from "../agent/lib/story-labels";

describe("finalizeLabels", () => {
  it("describes removing the trigger label and adding the done label on success", () => {
    const r = finalizeLabels({ success: true });
    expect(r.remove).toEqual(["needs-story"]);
    expect(r.add).toEqual(["user-story-added"]);
  });

  it("is a no-op for non-success (clarification) states", () => {
    const r = finalizeLabels({ success: false });
    expect(r.remove).toEqual([]);
    expect(r.add).toEqual([]);
  });

  it("exports the label constants", () => {
    expect(TRIGGER_LABEL).toBe("needs-story");
    expect(DONE_LABEL).toBe("user-story-added");
  });
});