import { describe, expect, it, vi } from "vitest";
import {
  ArchitectAgent,
  type ArchitectDeps,
} from "../../agent/lib/dark-factory/architect-agent";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

/**
 * #450 - when every plan attempt fails, the run must say WHAT rejected each one and WHICH rule fired.
 *
 * Live evidence: 3 of 10 runs parked with "no attempt produced a valid plan". `lastErrors` was
 * overwritten on every iteration, so only the last attempt's reason survived, and `refusedTarget` was
 * derived from the last attempt's codes only - so a target-role refusal could be reported as
 * `plan-invalid`. The attempts are also absent from any durable record.
 */
const REPO: Record<string, string> = {
  "src/App.jsx": [
    'import { Outlet } from "react-router-dom";',
    "export default function App() { return (<div><Outlet /></div>); }",
  ].join("\n"),
  "src/main.jsx": [
    'import { Routes, Route } from "react-router-dom";',
    'import App from "./App.jsx";',
    'import HomePage from "./pages/HomePage.jsx";',
    "export default function main() {",
    '  return (<Routes><Route path="/" element={<App />}><Route index element={<HomePage />} /></Route></Routes>);',
    "}",
  ].join("\n"),
  "src/pages/HomePage.jsx":
    "export default function HomePage() { return (<main><h1>Home</h1></main>); }",
};

const STORY = {
  number: 169,
  title: "Dark Factory Test Issue 7 (sandbox)",
  body: "As a test for the Dark Factory I want to create a new sub-heading on the main page of the application.",
};

/** A plan targeting `path`. The action is `modify` so existence rules apply to absent paths. */
function plan(path: string): ExecutionPlan {
  return {
    storyId: 169,
    title: "Dark Factory Test Issue 7 (sandbox)",
    summary: "Add a sub-heading to the main page",
    targetFiles: [{ path, action: "modify", rationale: "the surface the story means" }],
    acceptanceCriteriaMap: [
      {
        acId: "AC1",
        description: "the sub-heading reads Welcome to the site",
        testFile: "tests/homepage.test.tsx",
        testCaseName: "renders Welcome to the site",
      },
    ],
  };
}

/** A stub model that returns one scripted output per call, and records how it was invoked. */
function agentReplying(outputs: string[], maxPlanRetries = 2) {
  const calls: Array<{ prompt: string; attempt?: number }> = [];
  let index = 0;
  const deps: ArchitectDeps = {
    listFiles: vi.fn().mockResolvedValue(Object.keys(REPO)),
    readFile: async (p: string) => REPO[p] ?? "",
    maxPlanRetries,
    generateText: vi.fn().mockImplementation(
      async (prompt: string, options?: { attempt?: number }) => {
        calls.push({ prompt, attempt: options?.attempt });
        const out = outputs[Math.min(index, outputs.length - 1)] ?? "";
        index += 1;
        return out;
      },
    ),
  };
  return { agent: new ArchitectAgent(deps), calls };
}

describe("#450 - every attempt's reason survives", () => {
  it("records each attempt with its stage and reports all of them", async () => {
    const { agent } = agentReplying([
      JSON.stringify(plan("src/App.jsx")), // the target rule: the shell, not the page
      "this is not JSON at all", // a parse failure
      "still not JSON", // a parse failure
    ]);

    const result = await agent.planStory(STORY);

    expect(result.ok).toBe(false);
    expect(result.attempts?.length).toBe(3);
    expect(result.attempts?.[0]?.stage).toBe("validate");
    expect(result.attempts?.[0]?.codes).toContain("target-role");
    expect(result.attempts?.[1]?.stage).toBe("parse");
    expect(result.attempts?.[2]?.stage).toBe("parse");

    // The failure text must name EVERY attempt, not only the last one.
    const text = String(result.error);
    expect(text).toContain("attempt 1");
    expect(text).toContain("attempt 2");
    expect(text).toContain("attempt 3");
    expect(text).toContain("src/App.jsx");
    expect(text).toContain("max retries exceeded (2)");
  });

  it("carries the RULE CODE of a rejected attempt, not only its message", async () => {
    const { agent } = agentReplying([JSON.stringify(plan("src/components/Header.js"))]);

    const result = await agent.planStory(STORY);

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("target-missing");
    expect(result.attempts?.[0]?.errors?.join(" ")).toContain("src/components/Header.js");
  });

  it("records a successful attempt too, so the record shows which one won", async () => {
    const { agent } = agentReplying([
      "not JSON", // attempt 1 fails to parse
      JSON.stringify(plan("src/pages/HomePage.jsx")), // attempt 2 is accepted
    ]);

    const result = await agent.planStory(STORY);

    expect(result.ok).toBe(true);
    expect(result.retries).toBe(1);
    expect(result.attempts?.length).toBe(2);
    expect(result.attempts?.[0]?.stage).toBe("parse");
    expect(result.attempts?.[1]?.stage).toBe("accepted");
  });
});

describe("#450 - the park reason reflects every attempt, not the last one", () => {
  it("is refused-target when ANY attempt hit the target rule", async () => {
    const { agent } = agentReplying([
      JSON.stringify(plan("src/App.jsx")), // target-role on attempt 1
      JSON.stringify(plan("src/components/Header.js")), // target-missing, no target-role
      JSON.stringify(plan("src/components/Header.js")),
    ]);

    const result = await agent.planStory(STORY);

    expect(result.ok).toBe(false);
    // Today this reports plan-invalid, because the LAST attempt's codes decide.
    expect(result.reason).toBe("refused-target");
  });

  it("stays plan-invalid when NO attempt hit the target rule (control)", async () => {
    // #451 moved a target-missing plan to refused-target, so the control uses a failure that is NOT
    // about the target: an empty target list. Otherwise this would only re-test the refusal.
    const invalidPlan: ExecutionPlan = {
      ...plan("src/pages/HomePage.jsx"),
      targetFiles: [],
    };
    const { agent } = agentReplying([JSON.stringify(invalidPlan)]);

    const result = await agent.planStory(STORY);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("plan-invalid");
  });
});

describe("#450 - each attempt is identifiable in the stream", () => {
  it("tells the caller which attempt it is generating", async () => {
    const { agent, calls } = agentReplying(["not JSON", "not JSON", "not JSON"]);

    await agent.planStory(STORY);

    expect(calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
  });
});