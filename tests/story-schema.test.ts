import { describe, it, expect } from "vitest";
import {
  UserStorySchema,
  validateStory,
  NFR_DEFAULTS,
} from "../agent/lib/story-schema";

const goodStory = {
  id: "US-001",
  title: "Export report as CSV",
  intent:
    "A project manager can export the current sprint report as a CSV file from the report page.",
  acceptanceCriteria: [
    {
      given: "a sprint report with 12 items",
      when: "the user clicks Export CSV",
      then: "a UTF-8 CSV file downloads containing exactly 12 data rows plus one header row",
    },
  ],
  examples: [{ input: "click Export CSV", output: "report-2026-09-08.csv" }],
  constraints: ["MUST NOT block the UI thread during export"],
  nfrs: {
    performance: "p95 < 2s for 5k rows",
    security: "respect tenant scoping",
    latency: "n/a",
  },
  openQuestions: [],
};

describe("UserStorySchema", () => {
  it("accepts a complete story", () => {
    expect(UserStorySchema.safeParse(goodStory).success).toBe(true);
  });

  it("rejects a story with no acceptance criteria", () => {
    const r = UserStorySchema.safeParse({
      ...goodStory,
      acceptanceCriteria: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an intent under 20 chars (not unambiguous)", () => {
    const r = UserStorySchema.safeParse({ ...goodStory, intent: "do export" });
    expect(r.success).toBe(false);
  });

  it("rejects a constraint that is not a MUST/SHOULD/MAY statement", () => {
    const r = UserStorySchema.safeParse({
      ...goodStory,
      constraints: ["avoid slow things"],
    });
    expect(r.success).toBe(false);
  });
});

describe("validateStory", () => {
  it("returns ok for a complete story", () => {
    expect(validateStory(goodStory).ok).toBe(true);
  });

  it("lists missing sections when they are absent", () => {
    const r = validateStory({ ...goodStory, examples: [] });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("examples");
  });

  it("fills default NFRs when nfrs is omitted", () => {
    const { nfrs, ...withoutNfrs } = goodStory;
    void nfrs;
    const r = validateStory(withoutNfrs);
    expect(r.story?.nfrs).toEqual(NFR_DEFAULTS);
  });
});
