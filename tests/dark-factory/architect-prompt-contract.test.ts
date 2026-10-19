import { describe, expect, it, vi } from "vitest";
import {
  ArchitectAgent,
  type ArchitectDeps,
} from "../../agent/lib/dark-factory/architect-agent";
import { buildTargetContract } from "../../agent/lib/dark-factory/architect-prompt";
import type { FileRole } from "../../agent/lib/dark-factory/architect-discovery";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

/**
 * #381 R2 Task 8 - the TARGET CONTRACT is prompt behaviour, so it is asserted directly.
 *
 * The live run against WebFeedPOC #169 proved why this needs its own tests. Discovery resolved the
 * surface correctly (`src/pages/HomePage.jsx`, with `src/App.jsx` held as a shell) and the model then
 * produced five targets the repository does not contain:
 *
 *   src/components/Header.js, src/components/Footer.js, src/App.js, src/App.test.js, src/index.js
 *
 * The cause was one anonymous line of prompt: "If the story touches UI/Chat (mentions ... 'page' ...),
 * targetFiles MUST include UI entrypoints under app/ or components/". The story said "on the main page",
 * so the instruction ordered the model at the shared components - the files R2 exists to refuse - and
 * nothing had ever watched it fail, because it was a string inside a 900-line class.
 */
const STORY_TEXT = [
  "Dark Factory Test Issue 7 (sandbox)",
  "As a test for the Dark Factory I want to create a new sub-heading on the main page of the application.",
].join("\n");

const ROLES: Record<string, FileRole> = {
  "src/App.jsx": "shell",
  "src/main.jsx": "route",
  "src/pages/HomePage.jsx": "page",
  "src/components/Cart.jsx": "shared",
};

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

function agent(repo: Record<string, string>, responses: string[]) {
  const prompts: string[] = [];
  const deps: ArchitectDeps = {
    listFiles: vi.fn().mockResolvedValue(Object.keys(repo)),
    readFile: async (p: string) => repo[p] ?? "",
    generateText: vi.fn().mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return responses.shift() ?? JSON.stringify(plan("src/pages/HomePage.jsx"));
    }),
  };
  return { agent: new ArchitectAgent(deps), prompts };
}

describe("#381 R2 Task 8 - the target contract", () => {
  it("mandates the resolved page for a page-scoped story", () => {
    const text = buildTargetContract({
      storyText: STORY_TEXT,
      route: "/",
      page: "src/pages/HomePage.jsx",
      roles: ROLES,
    });

    expect(text).toContain("src/pages/HomePage.jsx");
    expect(text).toMatch(/scoped to one page/i);
  });

  it("names the shell and the shared component as forbidden, and says why", () => {
    const text = buildTargetContract({
      storyText: STORY_TEXT,
      route: "/",
      page: "src/pages/HomePage.jsx",
      roles: ROLES,
    });

    expect(text).toContain("src/App.jsx");
    expect(text).toContain("src/components/Cart.jsx");
    expect(text).toMatch(/forbidden/i);
    // The REASON has to travel with the ban, or the model cannot tell a legitimate shell story apart.
    expect(text).toMatch(/every route|shared/i);
  });

  it("requires every target path to exist in the repository, and forbids inventing one", () => {
    const text = buildTargetContract({
      storyText: STORY_TEXT,
      route: "/",
      page: "src/pages/HomePage.jsx",
      roles: ROLES,
    });

    expect(text).toMatch(/Existing files/i);
    expect(text).toMatch(/do not invent/i);
  });

  it("demotes app/ + components/ guidance to a FALLBACK, used only when no page resolved", () => {
    const withoutPage = buildTargetContract({ storyText: STORY_TEXT, roles: {} });
    const withPage = buildTargetContract({
      storyText: STORY_TEXT,
      route: "/",
      page: "src/pages/HomePage.jsx",
      roles: ROLES,
    });

    // No page resolved: the old guidance is still available, because it is better than nothing.
    expect(withoutPage).toMatch(/app\/|components\//);
    // A page resolved: it must not be an ORDER the evidence can lose to. This is the exact line that
    // produced five invented targets.
    expect(withPage).not.toMatch(/MUST include UI entrypoints under app\//);
  });

  it("tells the model NOT to reach for a shell when a page-scoped surface is unresolved", () => {
    const text = buildTargetContract({ storyText: STORY_TEXT, roles: {} });

    expect(text).toMatch(/do not target a shell|not a shell/i);
  });
});

describe("#381 R2 Task 8 - the ASSEMBLED prompt carries the contract", () => {
  it("puts the contract in front of the model, and drops the unconditional components/ order", async () => {
    const { agent: arch, prompts } = agent(REPO, [
      JSON.stringify(plan("src/pages/HomePage.jsx")),
    ]);

    const result = await arch.planStory({
      number: 169,
      title: "Dark Factory Test Issue 7 (sandbox)",
      body: "As a test for the Dark Factory I want to create a new sub-heading on the main page of the application.",
    });

    expect(result.ok).toBe(true);
    const first = prompts[0];
    expect(first).toContain("src/pages/HomePage.jsx");
    expect(first).toMatch(/forbidden/i);
    expect(first).not.toMatch(/MUST include UI entrypoints under app\//);
  });
});
