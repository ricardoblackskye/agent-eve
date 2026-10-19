import { describe, expect, it, vi } from "vitest";
import {
  ArchitectAgent,
  type ArchitectDeps,
} from "../../agent/lib/dark-factory/architect-agent";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

/**
 * #381 R2 AC3 + AC4 - the Architect acts on its own evidence, and asks a human when it has none.
 *
 * R1 gave it eyes. R2 makes the reading binding: a plan against the shell is REFUSED and repaired, and a
 * story scoped to a page discovery cannot identify produces a request for a human rather than a guess.
 */
const REPO: Record<string, string> = {
  "src/App.jsx": [
    'import { Outlet } from "react-router-dom";',
    "export default function App() { return (<div><Outlet /></div>); }",
  ].join("\n"),
  "src/routes.jsx": [
    'import { Routes, Route } from "react-router-dom";',
    'import HomePage from "./pages/HomePage";',
    "export default function AppRoutes() {",
    '  return (<Routes><Route path="/" element={<HomePage />} /></Routes>);',
    "}",
  ].join("\n"),
  "src/pages/HomePage.jsx": [
    "export default function HomePage() { return (<main><h1>Home</h1></main>); }",
  ].join("\n"),
};

/** No route table and no page: discovery cannot say which surface the story means. */
const OPAQUE_REPO: Record<string, string> = {
  "src/util.js": "export const add = (a, b) => a + b;",
  "README.md": "# Project",
};

const STORY = {
  number: 166,
  title: "Change the heading on the main page",
  body: ["**Acceptance Criteria**", "- AC1: the heading reads Hello"].join(
    "\n",
  ),
};

function plan(path: string): ExecutionPlan {
  return {
    storyId: 166,
    title: "Change the heading on the main page",
    summary: "Move the heading",
    targetFiles: [
      { path, action: "modify", rationale: "the surface the story means" },
    ],
    acceptanceCriteriaMap: [
      {
        acId: "AC1",
        description: "the heading reads Hello",
        testFile: "tests/homepage.test.tsx",
        testCaseName: "renders Hello",
      },
    ],
  };
}

function agent(
  repo: Record<string, string>,
  responses: string[],
  over: Partial<ArchitectDeps> = {},
) {
  const prompts: string[] = [];
  const deps: ArchitectDeps = {
    listFiles: vi.fn().mockResolvedValue(Object.keys(repo)),
    readFile: async (p: string) => repo[p] ?? "",
    generateText: vi.fn().mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return (
        responses.shift() ?? JSON.stringify(plan("src/pages/HomePage.jsx"))
      );
    }),
    ...over,
  };
  return {
    agent: new ArchitectAgent(deps),
    prompts,
    generateText: deps.generateText as ReturnType<typeof vi.fn>,
  };
}

describe("Architect target rules (#381 R2)", () => {
  it("REFUSES a shell target and repairs it to the page, telling the model why", async () => {
    const { agent: arch, prompts } = agent(REPO, [
      JSON.stringify(plan("src/App.jsx")),
      JSON.stringify(plan("src/pages/HomePage.jsx")),
    ]);

    const result = await arch.planStory(STORY);

    expect(result.ok).toBe(true);
    expect(result.plan?.targetFiles.map((f) => f.path)).toEqual([
      "src/pages/HomePage.jsx",
    ]);
    // The repair prompt must carry the refusal, or the second attempt is a fresh guess.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/scoped to one page/i);
    expect(prompts[1]).toContain("src/pages/HomePage.jsx");
  });

  it("reports an unresolved surface instead of guessing, and spends NO model call", async () => {
    const { agent: arch, generateText } = agent(OPAQUE_REPO, []);

    const result = await arch.planStory(STORY);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unresolved-surface");
    // Fail-closed by construction: nothing was asked, so nothing could be guessed.
    expect(generateText).not.toHaveBeenCalled();
  });

  it("surfaces the roles and the surface it used, so the caller can judge the plan", async () => {
    const { agent: arch } = agent(REPO, [
      JSON.stringify(plan("src/pages/HomePage.jsx")),
    ]);

    const result = await arch.planStory(STORY);

    expect(result.ok).toBe(true);
    expect(result.surface).toEqual({
      route: "/",
      page: "src/pages/HomePage.jsx",
    });
    expect(result.roles?.["src/App.jsx"]?.role).toBe("shell");
    expect(result.roles?.["src/pages/HomePage.jsx"]?.role).toBe("page");
  });

  it("does not gate when no reader is configured", async () => {
    // Backward compatibility: with no way to read, the agent cannot resolve a surface and must not park.
    const { agent: arch, prompts } = agent(
      OPAQUE_REPO,
      [JSON.stringify(plan("src/pages/HomePage.jsx"))],
      {
        readFile: undefined,
      },
    );

    const result = await arch.planStory(STORY);

    expect(result.ok).toBe(true);
    expect(prompts).toHaveLength(1);
  });
});
