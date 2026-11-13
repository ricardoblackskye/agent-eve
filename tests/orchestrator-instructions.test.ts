import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const INSTRUCTIONS = resolve(process.cwd(), "agent/instructions.md");
const AGENT_TS = resolve(process.cwd(), "agent/agent.ts");

describe("orchestrator persona source", () => {
  it("loads its persona from agent/instructions.md and is non-empty", () => {
    expect(existsSync(INSTRUCTIONS), "agent/instructions.md must exist").toBe(true);
    const stats = statSync(INSTRUCTIONS);
    const text = readFileSync(INSTRUCTIONS, "utf8");
    expect(stats.size).toBeGreaterThan(0);
    expect(text).toContain("# Identity");
  });

  it("is the orchestrator's own persona, not the stock Eve template", () => {
    const text = readFileSync(INSTRUCTIONS, "utf8");
    // The role must be named: a persona that does not say what it is is not a persona.
    expect(text).toMatch(/Orchestrator/);
    // The generic Eve demo template must not remain — it means the role has no persona of its own.
    expect(text).not.toMatch(/an intelligent AI assistant built with the Eve framework/i);
  });

  it("declares instructions.md as the orchestrator persona at the defineAgent call", () => {
    const agentTs = readFileSync(AGENT_TS, "utf8");
    // The defineAgent call must state the persona comes from instructions.md via discovery.
    expect(agentTs).toMatch(/instructions\.md[^\n]*orchestrator persona/i);
  });
});
