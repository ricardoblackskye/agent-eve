import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const INSTRUCTIONS = resolve(process.cwd(), "agent/instructions.md");
const AGENT_TS = resolve(process.cwd(), "agent/agent.ts");

describe("root chat agent persona source", () => {
  it("loads its persona from agent/instructions.md and is non-empty", () => {
    expect(existsSync(INSTRUCTIONS), "agent/instructions.md must exist").toBe(true);
    const stats = statSync(INSTRUCTIONS);
    const text = readFileSync(INSTRUCTIONS, "utf8");
    expect(stats.size).toBeGreaterThan(0);
    expect(text).toContain("# Identity");
  });

  it("is the default Eve assistant, NOT the Dark Factory Orchestrator", () => {
    const text = readFileSync(INSTRUCTIONS, "utf8");
    // The root chat agent is the original default Eve assistant.
    expect(text).toMatch(/You are Eve Agent/);
    // The Orchestrator is a SEPARATE agent (agent/subagents/orchestrator); its persona must
    // never live here, or the front page starts talking as the Orchestrator instead of Eve.
    expect(text).not.toMatch(/Orchestrator/i);
  });

  it("declares instructions.md at the defineAgent call as the persona loaded by discovery", () => {
    const agentTs = readFileSync(AGENT_TS, "utf8");
    expect(agentTs).toMatch(/instructions\.md[^\n]*(root chat agent|loaded by Eve's discovery)/i);
  });
});
