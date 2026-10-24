import { describe, expect, it, vi } from "vitest";
import {
  ArchitectAgent,
  type ArchitectDeps,
} from "../../agent/lib/dark-factory/architect-agent";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

/**
 * #381 R2 Task 8 - a plan that never validates is a QUESTION, not a crash.
 *
 * The second live run ended with `ArchitectAgent max retries exceeded (2)` and a terminal failure. The
 * story was fine, the repository was fine; the plan named files that do not exist. A human could have
 * answered that, and a terminal failure threw the run away instead.
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

function alwaysReplying(body: string) {
  const prompts: string[] = [];
  const deps: ArchitectDeps = {
    listFiles: vi.fn().mockResolvedValue(Object.keys(REPO)),
    readFile: async (p: string) => REPO[p] ?? "",
    generateText: vi.fn().mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return body;
    }),
  };
  return { agent: new ArchitectAgent(deps), prompts };
}

describe("#381 R2 Task 8 - a plan that never validates is answerable, so it is reported as such", () => {
  it("reports refused-target when every attempt targets a file outside the repository (#451)", async () => {
    // The exact live failure: a path the repository does not contain, every time. #451 classifies this
    // as a refused target rather than an invalid plan, because the plan has left the discovered repo and
    // another repair round cannot bring it back.
    const { agent: arch } = alwaysReplying(JSON.stringify(plan("src/components/Header.js")));

    const result = await arch.planStory(STORY);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("refused-target");
    expect(String(result.error)).toContain("src/components/Header.js");
  });

  it("still reports plan-invalid when the failure is NOT about the target (#451 control)", async () => {
    // An empty target list fails presence without naming a wrong repository, so the refusal
    // classification must not swallow it: this stays an answerable plan-invalid.
    const invalidPlan: ExecutionPlan = { ...plan("src/pages/HomePage.jsx"), targetFiles: [] };
    const { agent: arch } = alwaysReplying(JSON.stringify(invalidPlan));

    const result = await arch.planStory(STORY);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("plan-invalid");
  });

  it("still reports refused-target when the TARGET RULE is what kept failing", async () => {
    // The more specific reason wins: a refused target asks a different question of a human.
    const { agent: arch } = alwaysReplying(JSON.stringify(plan("src/App.jsx")));

    const result = await arch.planStory(STORY);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("refused-target");
  });

  it("spends its repair rounds before asking, and asks only once", async () => {
    const { agent: arch, prompts } = alwaysReplying(
      JSON.stringify(plan("src/components/Header.js")),
    );

    const result = await arch.planStory(STORY);

    // One initial attempt plus maxPlanRetries repairs - never an unbounded loop on a planning fault.
    expect(prompts).toHaveLength(3);
    expect(result.retries).toBe(2);
  });
});
