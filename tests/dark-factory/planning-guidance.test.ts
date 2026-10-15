import { describe, expect, it, vi } from "vitest";
import { ArchitectAgent } from "../../agent/lib/dark-factory/architect-agent";
import {
  PLANNING_GUIDANCE_SOURCE,
  WRITING_PLANS_GUIDANCE,
  planningGuidanceForPrompt,
} from "../../agent/lib/dark-factory/planning-guidance";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

/**
 * #361 Task 7 — the architect must plan using the vendored Superpowers guidance.
 *
 * "We use the skill" has to be provable, so the guidance reaching the architect prompt is asserted
 * directly rather than assumed from the presence of a file.
 */
describe("planning guidance (#361 Task 7)", () => {
  const story = {
    number: 99,
    title: "Add Google Authentication to the Eve Chat",
    body: `**Acceptance Criteria**\n- AC1: given an unauthenticated user navigates to the Eve Chat UI, when the page loads, then the user is redirected\n`,
  };

  const validPlan: ExecutionPlan = {
    storyId: 99,
    title: "Add Google Authentication to the Eve Chat",
    summary: "Integrate Google OAuth into Eve Chat UI",
    targetFiles: [
      { path: "app/chat.tsx", action: "modify", rationale: "Add auth guard" },
      { path: "app/google-auth.ts", action: "create", rationale: "OAuth validator" },
    ],
    acceptanceCriteriaMap: [
      {
        acId: "AC1",
        description: "Redirect unauthenticated user",
        testFile: "tests/chat-auth.test.ts",
        testCaseName: "redirects to sign-in",
      },
    ],
  };

  /** A distinctive instruction from the upstream text, used to prove the copy is the real one. */
  const UPSTREAM_MARKER = "bite-sized tasks";

  const newAgent = (generateText: ReturnType<typeof vi.fn>) =>
    new ArchitectAgent({
      listFiles: vi.fn().mockResolvedValue(["app/chat.tsx", "app/page.tsx"]),
      readFile: vi.fn().mockResolvedValue(""),
      generateText,
    } as never);

  it("records where the vendored copy came from, so it can be synced", () => {
    expect(PLANNING_GUIDANCE_SOURCE.repository).toContain("github.com/obra/superpowers");
    expect(PLANNING_GUIDANCE_SOURCE.url).toContain("writing-plans/SKILL.md");
    // Pinned to a commit, not a branch: a branch would silently change under a sync.
    expect(PLANNING_GUIDANCE_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(PLANNING_GUIDANCE_SOURCE.url).toContain(PLANNING_GUIDANCE_SOURCE.commit);
    expect(PLANNING_GUIDANCE_SOURCE.licence).toBe("MIT");
  });

  it("carries the upstream guidance itself, not a stub", () => {
    expect(WRITING_PLANS_GUIDANCE).toContain("Writing Plans");
    expect(WRITING_PLANS_GUIDANCE).toContain(UPSTREAM_MARKER);
    // Long enough to be the real skill rather than a placeholder.
    expect(WRITING_PLANS_GUIDANCE.length).toBeGreaterThan(5000);
  });

  it("keeps the maintainer-facing attribution out of what the model reads", () => {
    // The header is advice to whoever syncs the copy; sending it to the architect wastes context and
    // invites the model to treat it as instructions.
    const promptReady = planningGuidanceForPrompt();
    expect(promptReady).toContain(UPSTREAM_MARKER);
    expect(promptReady).not.toContain("TO SYNC");
    expect(promptReady).not.toContain("Re-fetch the URL above");
  });

  it("reaches the architect's initial prompt, so using the skill is provable", async () => {
    const generateText = vi.fn().mockResolvedValue(JSON.stringify(validPlan));
    await newAgent(generateText).planStory(story);

    const prompt = generateText.mock.calls[0][0] as string;
    expect(prompt).toContain(UPSTREAM_MARKER);
  });

  it("keeps the guidance OUTSIDE the untrusted story block", async () => {
    // Vendored text is trusted; the story is not, and must stay contained where it was.
    const generateText = vi.fn().mockResolvedValue(JSON.stringify(validPlan));
    await newAgent(generateText).planStory(story);

    const prompt = generateText.mock.calls[0][0] as string;
    const storyStart = prompt.indexOf("<user_story>");
    const storyEnd = prompt.indexOf("</user_story>");
    const guidanceAt = prompt.indexOf(UPSTREAM_MARKER);

    expect(storyStart).toBeGreaterThan(-1);
    expect(storyEnd).toBeGreaterThan(storyStart);
    // Asserted present FIRST: otherwise an absent marker would satisfy the position check vacuously.
    expect(guidanceAt).toBeGreaterThan(-1);
    expect(guidanceAt > storyEnd || guidanceAt < storyStart).toBe(true);
  });
});
