import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dir = path.join(process.cwd(), "agent", "subagents", "product-owner");

describe("product-owner subagent", () => {
  it("has an agent.ts with a required description", () => {
    const src = fs.readFileSync(path.join(dir, "agent.ts"), "utf8");
    expect(src).toMatch(/description:\s*\n?\s*["'`]/);
  });

  it("declares a model", () => {
    const src = fs.readFileSync(path.join(dir, "agent.ts"), "utf8");
    expect(src).toMatch(/model:/);
  });

  it("does not hardcode the model id (uses MODEL_NAME env)", () => {
    const src = fs.readFileSync(path.join(dir, "agent.ts"), "utf8");
    expect(src).toMatch(/MODEL_NAME/);
  });

  it("has instructions covering all five story sections", () => {
    const src = fs
      .readFileSync(path.join(dir, "instructions.md"), "utf8")
      .toLowerCase();
    for (const section of [
      "intent",
      "acceptance",
      "example",
      "constraint",
      "nfr",
    ]) {
      expect(src).toContain(section);
    }
  });

  it("instructs the agent to pause and ask when data is missing", () => {
    const src = fs
      .readFileSync(path.join(dir, "instructions.md"), "utf8")
      .toLowerCase();
    expect(src).toMatch(/needs_clarification|clarif/);
  });

  it("has all three tools in its tools directory", () => {
    const tools = fs.readdirSync(path.join(dir, "tools"));
    expect(tools).toContain("draft_user_story.ts");
    expect(tools).toContain("publish_story.ts");
    expect(tools).toContain("comment_questions.ts");
  });
});
