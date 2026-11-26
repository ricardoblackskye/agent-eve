import { describe, expect, it, vi } from "vitest";
import {
  ArchitectAgent,
  type ArchitectDeps,
} from "../../agent/lib/dark-factory/architect-agent";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

/**
 * #770 - the rule now fires at the ARCHITECT stage, where a refusal is REPAIRED rather than fatal.
 *
 * This is the stage that protects production runs. The architect validates with `files` whenever discovery ran and
 * actually read the repository (`gated && sawEvidence`, architect-agent.ts:1109-1113), and the runner wires both
 * seams that makes true (`readFile` and `listFiles`). On refusal the loop's repair callback (#451) regenerates the
 * plan, so a misclassified action is corrected BEFORE the plan is posted and no human sees it. STEP 4 in the runner
 * is the backstop for whatever this stage cannot catch.
 *
 * Before #770 this stage could not catch it at all: `if (file.action === "create") continue;` skipped the check even
 * with a file list supplied, so the plan was compared to itself and shipped as `create`.
 *
 * The targets are PAGE-level because the story is page-scoped: naming the app shell is refused by the `target-role`
 * rule (measured - "Target 'src/App.jsx' is the application shell ... Target src/pages/HomePage.jsx instead"), which
 * would mask the rule under test. Rationales cite each file's role for the same reason.
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
  // The file whose existence is the whole subject: already present, and so `create` is a misclassification.
  "src/pages/HomePage.test.jsx":
    'import { describe, it } from "vitest";\ndescribe("HomePage", () => { it("renders", () => {}); });',
};

const STORY = {
  number: 169,
  title: "Dark Factory Test Issue 7 (sandbox)",
  body: "As a test for the Dark Factory I want to create a new sub-heading on the main page of the application.",
};

type Target = { path: string; action: "create" | "modify" | "replace" };

const RATIONALE_PAGE =
  "src/pages/HomePage.jsx is the page component the home route renders; it composes the main landmark the sub-heading belongs in.";
const RATIONALE_SPEC =
  "src/pages/HomePage.test.jsx is the co-located spec for that page component, so coverage for the new sub-heading belongs here.";

function plan(targets: Array<{ path: string; action: Target["action"]; rationale: string }>): ExecutionPlan {
  return {
    storyId: 169,
    title: "Dark Factory Test Issue 7 (sandbox)",
    summary: "Add a sub-heading to the main page",
    targetFiles: targets,
    acceptanceCriteriaMap: [
      {
        acId: "AC1",
        description: "the sub-heading reads Welcome to the site",
        testFile: "src/pages/HomePage.test.jsx",
        testCaseName: "renders Welcome to the site",
      },
    ],
  };
}

/** The live defect at page level: the page modified, its EXISTING spec misclassified as `create`. */
const LIVE_SHAPE = JSON.stringify(
  plan([
    { path: "src/pages/HomePage.jsx", action: "modify", rationale: RATIONALE_PAGE },
    { path: "src/pages/HomePage.test.jsx", action: "create", rationale: RATIONALE_SPEC },
  ]),
);

/** The same plan with the action restated - what a repair is expected to produce. */
const REPAIRED = JSON.stringify(
  plan([
    { path: "src/pages/HomePage.jsx", action: "modify", rationale: RATIONALE_PAGE },
    { path: "src/pages/HomePage.test.jsx", action: "modify", rationale: RATIONALE_SPEC },
  ]),
);

/** Replies with each body in turn; the last body repeats, so a runaway loop is still observable. */
function replyingInTurn(bodies: string[]) {
  const prompts: string[] = [];
  let call = 0;
  const deps: ArchitectDeps = {
    listFiles: vi.fn().mockResolvedValue(Object.keys(REPO)),
    readFile: async (p: string) => REPO[p] ?? "",
    generateText: vi.fn().mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      const body = bodies[Math.min(call, bodies.length - 1)];
      call += 1;
      return body;
    }),
  };
  return { agent: new ArchitectAgent(deps), prompts };
}

describe("#770 - a create target that exists is refused and repaired at the architect stage", () => {
  it("repairs the plan instead of shipping the misclassified action", async () => {
    const { agent: arch, prompts } = replyingInTurn([LIVE_SHAPE, REPAIRED]);

    const result = await arch.planStory(STORY);

    // A second call IS the repair: were the rule not firing, the first plan would have validated and the loop
    // would have stopped at one.
    expect(prompts).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(result.plan?.targetFiles.map((f) => f.action)).toEqual(["modify", "modify"]);
    expect(result.plan?.targetFiles.some((f) => f.action === "create")).toBe(false);
  });

  it("the second prompt is a REPAIR prompt, so the refusal is what caused it", async () => {
    const { agent: arch, prompts } = replyingInTurn([LIVE_SHAPE, REPAIRED]);

    await arch.planStory(STORY);

    // The first prompt is the initial one; only a refused plan gets the repair prompt.
    expect(prompts[0]).not.toContain("failed domain validation");
    expect(prompts[1]).toContain("failed domain validation");
  });

  it("CONTROL: a plan whose actions are already correct is not repaired", async () => {
    const { agent: arch, prompts } = replyingInTurn([REPAIRED]);

    const result = await arch.planStory(STORY);

    // One call: nothing was refused, so no repair was owed. Without this, the case above would pass for a loop
    // that simply always tries twice.
    expect(prompts).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it("CONTROL: a create on an ABSENT file is still accepted, so genuine new files survive", async () => {
    const freshFile = JSON.stringify(
      plan([
        { path: "src/pages/HomePage.jsx", action: "modify", rationale: RATIONALE_PAGE },
        {
          path: "src/pages/HomePage.extra.test.jsx", // not in REPO
          action: "create",
          rationale: "A new co-located spec for the page component: it does not exist yet, so create is correct.",
        },
      ]),
    );
    const { agent: arch, prompts } = replyingInTurn([freshFile]);

    const result = await arch.planStory(STORY);

    // The rule that refuses an existing target must not refuse a new one, or it would block every new file.
    expect(prompts).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.plan?.targetFiles.some((f) => f.action === "create")).toBe(true);
  });
});
