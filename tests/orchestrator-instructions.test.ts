import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const INSTRUCTIONS = resolve(process.cwd(), "agent/instructions.md");
const AGENT_TS = resolve(process.cwd(), "agent/agent.ts");
const ORCH_INSTRUCTIONS = resolve(
  process.cwd(),
  "agent/subagents/orchestrator/instructions.md",
);
const ORCH_AGENT_TS = resolve(process.cwd(), "agent/subagents/orchestrator/agent.ts");

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

describe("orchestrator subagent persona", () => {
  it("has its own persona file that names the Orchestrator", () => {
    expect(
      existsSync(ORCH_INSTRUCTIONS),
      "agent/subagents/orchestrator/instructions.md must exist",
    ).toBe(true);
    const text = readFileSync(ORCH_INSTRUCTIONS, "utf8");
    expect(statSync(ORCH_INSTRUCTIONS).size).toBeGreaterThan(0);
    expect(text).toContain("# Identity");
    expect(text).toMatch(/Orchestrator/);
  });

  it("is wired as an Eve subagent with a description", () => {
    expect(
      existsSync(ORCH_AGENT_TS),
      "agent/subagents/orchestrator/agent.ts must exist",
    ).toBe(true);
    const src = readFileSync(ORCH_AGENT_TS, "utf8");
    expect(src).toMatch(/defineAgent\(/);
    expect(src).toMatch(/description/);
    expect(src).toMatch(/export default/);
  });
});
