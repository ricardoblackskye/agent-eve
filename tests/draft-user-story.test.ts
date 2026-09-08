import { describe, it, expect, vi, afterEach } from "vitest";
import tool from "../agent/subagents/product-owner/tools/draft_user_story";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function run(
  input: Record<string, unknown>,
): Promise<Record<string, any>> {
  const result = await (tool.execute as any)(input, {} as any);
  return result as Record<string, any>;
}

const complete = {
  title: "Export report as CSV",
  intent:
    "A project manager can export the current sprint report as a CSV file from the report page.",
  acceptanceCriteria: [
    {
      given: "a report with 12 items",
      when: "click Export CSV",
      then: "a file with 12 rows downloads",
    },
  ],
  examples: [{ input: "click Export CSV", output: "report.csv" }],
  constraints: ["MUST NOT block the UI thread"],
};

describe("draft_user_story", () => {
  it("is a valid eve tool definition", () => {
    expect(tool.description.length).toBeGreaterThan(10);
    expect(tool.inputSchema).toBeDefined();
  });

  it("returns status complete for a specific draft", async () => {
    const r = await run(complete);
    expect(r.status).toBe("complete");
    expect(r.payload.story.acceptanceCriteria).toHaveLength(1);
  });

  it("returns status needs_clarification with questions for a vague draft", async () => {
    const r = await run({
      ...complete,
      intent: "make it better",
      examples: [],
    });
    expect(r.status).toBe("needs_clarification");
    expect(r.questions.length).toBeGreaterThan(0);
  });

  it("auto-fills NFRs when omitted", async () => {
    const r = await run(complete);
    expect(r.payload.nfrs.performance).toBeTruthy();
    expect(r.payload.nfrs.security).toBeTruthy();
  });
});
