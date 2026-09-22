import { describe, it, expect, vi } from "vitest";
import {
  ArchitectAgent,
  type ArchitectDeps,
} from "../../agent/lib/dark-factory/architect-agent";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

describe("Architect Agent", () => {
  const sampleStory = {
    number: 99,
    title: "Add Google Authentication to the Eve Chat",
    body: `
**Intent**
A user must authenticate via Google OAuth before accessing the Eve Chat UI.

**Acceptance Criteria**
- AC1: given an unauthenticated user navigates to the Eve Chat UI, when the page loads, then the user is redirected to a Google sign-in prompt
- AC2: given a user completes Google sign-in with the email cuillinguy@gmail.com, when authentication finishes, then the user is granted access to the Eve Chat UI
`,
  };

  const validPlan: ExecutionPlan = {
    storyId: 99,
    title: "Add Google Authentication to the Eve Chat",
    summary: "Integrate Google OAuth into Eve Chat UI",
    targetFiles: [
      {
        path: "app/chat.tsx",
        action: "modify",
        rationale: "Add auth guard",
      },
      {
        path: "app/google-auth.ts",
        action: "create",
        rationale: "OAuth token validator",
      },
    ],
    acceptanceCriteriaMap: [
      {
        acId: "AC1",
        description: "Redirect unauthenticated user",
        testFile: "tests/chat-auth.test.ts",
        testCaseName: "redirects to Google sign-in",
      },
      {
        acId: "AC2",
        description: "Grant allowed user access",
        testFile: "tests/chat-auth.test.ts",
        testCaseName: "grants access for allowed email",
      },
    ],
  };

  it("successfully synthesizes an approved ExecutionPlan on the first attempt", async () => {
    const deps: ArchitectDeps = {
      listFiles: vi.fn().mockResolvedValue(["app/chat.tsx", "app/page.tsx", "package.json"]),
      readFile: vi.fn().mockResolvedValue(""),
      generateText: vi.fn().mockResolvedValue(JSON.stringify(validPlan)),
    };

    const agent = new ArchitectAgent(deps);
    const result = await agent.planStory(sampleStory);

    expect(result.ok).toBe(true);
    expect(result.plan).toEqual(validPlan);
    expect(result.retries).toBe(0);
    expect(deps.listFiles).toHaveBeenCalledWith(".");
    expect(deps.generateText).toHaveBeenCalledTimes(1);
  });

  it("self-corrects and retries when initial plan fails domain validation", async () => {
    // First attempt omits app/ touchpoints (invalid for UI story)
    const invalidPlan: ExecutionPlan = {
      ...validPlan,
      targetFiles: [
        {
          path: "agent/google-auth.ts",
          action: "create",
          rationale: "pure helper only",
        },
      ],
    };

    const generateTextMock = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(invalidPlan))
      .mockResolvedValueOnce(JSON.stringify(validPlan));

    const deps: ArchitectDeps = {
      listFiles: vi.fn().mockResolvedValue(["app/chat.tsx", "app/page.tsx"]),
      readFile: vi.fn().mockResolvedValue(""),
      generateText: generateTextMock,
      maxPlanRetries: 2,
    };

    const agent = new ArchitectAgent(deps);
    const result = await agent.planStory(sampleStory);

    expect(result.ok).toBe(true);
    expect(result.plan).toEqual(validPlan);
    expect(result.retries).toBe(1);
    expect(generateTextMock).toHaveBeenCalledTimes(2);

    // Verify repair prompt contains the validation error message
    const repairPrompt = generateTextMock.mock.calls[1][0];
    expect(repairPrompt).toContain("UI/Chat story must modify or create files under app/ or components/");
  });

  it("fails closed when validation retries exceed maxPlanRetries", async () => {
    const invalidPlan: ExecutionPlan = {
      ...validPlan,
      targetFiles: [], // empty target files is invalid
    };

    const deps: ArchitectDeps = {
      listFiles: vi.fn().mockResolvedValue(["app/chat.tsx"]),
      readFile: vi.fn().mockResolvedValue(""),
      generateText: vi.fn().mockResolvedValue(JSON.stringify(invalidPlan)),
      maxPlanRetries: 2,
    };

    const agent = new ArchitectAgent(deps);
    const result = await agent.planStory(sampleStory);

    expect(result.ok).toBe(false);
    expect(result.plan).toBeUndefined();
    expect(result.error).toContain("exceeded max retries (2)");
  });

  it("handles unparseable LLM output cleanly and triggers retry", async () => {
    const generateTextMock = vi
      .fn()
      .mockResolvedValueOnce("Not a JSON string")
      .mockResolvedValueOnce(JSON.stringify(validPlan));

    const deps: ArchitectDeps = {
      listFiles: vi.fn().mockResolvedValue(["app/chat.tsx"]),
      readFile: vi.fn().mockResolvedValue(""),
      generateText: generateTextMock,
      maxPlanRetries: 2,
    };

    const agent = new ArchitectAgent(deps);
    const result = await agent.planStory(sampleStory);

    expect(result.ok).toBe(true);
    expect(result.plan).toEqual(validPlan);
    expect(result.retries).toBe(1);
  });
});
