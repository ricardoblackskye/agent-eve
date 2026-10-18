import { describe, expect, it, vi } from "vitest";
import { ArchitectAgent, type ArchitectDeps } from "../../agent/lib/dark-factory/architect-agent";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

/**
 * #381 R1 AC1 / AC2 / AC5 / AC6 - the Architect plans from file CONTENTS, within budget, citing evidence.
 *
 * The fixture is the shape that actually failed: "the main page" belongs to `src/pages/HomePage.jsx`, while
 * `src/App.jsx` is the SHELL rendered on every route and `ProductList` is SHARED by two pages. A plan that
 * targets either of the latter is wrong however confident its rationale sounds.
 */
const REPO: Record<string, string> = {
  "src/App.jsx": [
    'import { Outlet, Link } from "react-router-dom";',
    "export default function App() {",
    '  return (<div><nav><Link to="/">Home</Link></nav><Outlet /></div>);',
    "}",
  ].join("\n"),
  "src/routes.jsx": [
    'import { Routes, Route } from "react-router-dom";',
    'import HomePage from "./pages/HomePage";',
    'import CategoryPage from "./pages/CategoryPage";',
    "export default function AppRoutes() {",
    '  return (<Routes><Route path="/" element={<HomePage />} />',
    '    <Route path="/category/:slug" element={<CategoryPage />} /></Routes>);',
    "}",
  ].join("\n"),
  "src/pages/HomePage.jsx": [
    'import ProductList from "../components/ProductList";',
    "export default function HomePage() {",
    '  return (<main><h1>Show HN</h1><ProductList /></main>);',
    "}",
  ].join("\n"),
  "src/pages/CategoryPage.jsx": [
    'import ProductList from "../components/ProductList";',
    "export default function CategoryPage() { return (<main><ProductList /></main>); }",
  ].join("\n"),
  "src/components/ProductList.jsx": [
    "export default function ProductList() { return (<ul><li>item</li></ul>); }",
  ].join("\n"),
};

const STORY = {
  number: 166,
  title: "Change the heading on the main page",
  body: ["**Acceptance Criteria**", "- AC1: the home page shows the new heading"].join("\n"),
};

const PLAN: ExecutionPlan = {
  storyId: 166,
  title: "Change the heading on the main page",
  summary: "Move the heading on the page the story names",
  targetFiles: [
    {
      path: "src/pages/HomePage.jsx",
      action: "modify",
      rationale: 'route "/" -> src/pages/HomePage.jsx, the surface the story means',
    },
  ],
  acceptanceCriteriaMap: [
    {
      acId: "AC1",
      description: "the home page shows the new heading",
      testFile: "src/pages/HomePage.test.jsx",
      testCaseName: "renders the new heading",
    },
  ],
};

/** An agent over REPO, recording every prompt it is given. */
function agentOver(over: Partial<ArchitectDeps> = {}) {
  const prompts: string[] = [];
  const deps: ArchitectDeps = {
    listFiles: vi.fn().mockResolvedValue(Object.keys(REPO)),
    readFile: async (p: string) => REPO[p] ?? "",
    generateText: vi.fn().mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify(PLAN);
    }),
    ...over,
  };
  return { agent: new ArchitectAgent(deps), prompts, generateText: deps.generateText as ReturnType<typeof vi.fn> };
}

describe("Architect reads the repository (#381 R1)", () => {
  it("puts the target file's CONTENTS in the prompt, escaped", async () => {
    const { agent, prompts } = agentOver();
    const result = await agent.planStory(STORY);

    expect(result.ok).toBe(true);
    const prompt = prompts[0];
    // The Architect can now see what the file IS, rather than only that it exists.
    expect(prompt).toContain("ProductList");
    expect(prompt).toContain("HomePage");
    // Escaped: file contents are untrusted data and must not become prompt STRUCTURE.
    expect(prompt).toContain("&lt;h1&gt;");
    expect(prompt).not.toContain("<h1>Show HN</h1>");
  });

  it("carries the ROLE and the composition path, so a rationale can cite evidence", async () => {
    const { agent, prompts } = agentOver();
    await agent.planStory(STORY);
    const prompt = prompts[0];

    // The shell is identified as a shell, in the prompt, where the model can read it.
    expect(prompt).toMatch(/shell/i);
    expect(prompt).toMatch(/rendered on every route/i);
    // And the shared component's evidence names the pages that prove it.
    expect(prompt).toMatch(/reached from/i);
  });

  it("says WHEN a file it read was truncated", async () => {
    const big = `${"// padding line to exceed the per-file cap\n".repeat(400)}export const x = 1;`;
    const { agent, prompts } = agentOver({
      readFile: async (p: string) => (p === "src/pages/HomePage.jsx" ? big : REPO[p] ?? ""),
      readerLimits: { maxCharsPerFile: 2_000 },
    });
    const result = await agent.planStory(STORY);

    expect(result.ok).toBe(true);
    // A fragment presented as a whole file is worse than no file: the model would reason from it anyway.
    expect(prompts[0]).toMatch(/truncated/i);
  });

  it("states what it omitted rather than silently dropping files", async () => {
    const { agent, prompts } = agentOver({ maxPromptChars: 2_600 });
    const result = await agent.planStory(STORY);

    expect(result.ok).toBe(true);
    expect(prompts[0]).toMatch(/omitted/i);
  });

  it("keeps the prompt inside its budget", async () => {
    const budget = 3_000;
    const { agent, prompts } = agentOver({ maxPromptChars: budget });
    const result = await agent.planStory(STORY);

    expect(result.ok).toBe(true);
    expect(prompts[0].length).toBeLessThanOrEqual(budget);
  });

  it("fails CLOSED when even the instructions cannot fit", async () => {
    const { agent, prompts, generateText } = agentOver({ maxPromptChars: 200 });
    const result = await agent.planStory(STORY);

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/budget|fit/i);
    // Nothing was sent: an over-budget prompt is refused, not truncated into an invalid one.
    expect(generateText).not.toHaveBeenCalled();
    expect(prompts).toEqual([]);
  });

  it("makes EXACTLY ONE model call for an attempt - reads add no spend", async () => {
    const { agent, prompts, generateText } = agentOver();
    const result = await agent.planStory(STORY);

    expect(result.ok).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(1);
    // ...and that one call carried the contents, so the count is not one because reads were skipped.
    expect(prompts[0]).toContain("&lt;h1&gt;");
  });

  it("behaves as before when no reader is supplied", async () => {
    const { agent, prompts } = agentOver({ readFile: undefined });
    const result = await agent.planStory(STORY);

    expect(result.ok).toBe(true);
    // Still plans from the file list; it simply has no contents to offer.
    expect(prompts[0]).toContain("src/pages/HomePage.jsx");
    expect(prompts[0]).not.toContain("&lt;h1&gt;");
  });
});
