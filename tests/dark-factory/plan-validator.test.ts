import { describe, it, expect } from "vitest";
import {
  validateExecutionPlan,
  type ExecutionPlan,
} from "../../agent/lib/dark-factory/plan-validator";

describe("Execution Plan Domain Validator", () => {
  const basePlan: ExecutionPlan = {
    storyId: 99,
    title: "Add Google Authentication to the Eve Chat",
    summary: "Integrate Google OAuth into the Eve Chat UI and gate access",
    targetFiles: [
      {
        path: "app/chat.tsx",
        action: "modify",
        rationale: "Add authentication guard and user status header",
      },
      {
        path: "app/google-auth.ts",
        action: "create",
        rationale: "OAuth token validation helper and profile checker",
      },
    ],
    acceptanceCriteriaMap: [
      {
        acId: "AC1",
        description: "Unauthenticated user navigates to Eve Chat -> redirected to Google sign-in",
        testFile: "tests/chat-auth.test.ts",
        testCaseName: "redirects unauthenticated user to Google sign-in",
      },
      {
        acId: "AC2",
        description: "cuillinguy@gmail.com granted access upon sign-in",
        testFile: "tests/chat-auth.test.ts",
        testCaseName: "grants access for allowed Google email",
      },
    ],
    dependencies: ["@react-oauth/google"],
  };

  const sampleStoryText = `
**Intent**
A user must authenticate via Google OAuth before accessing the Eve Chat UI.

**Acceptance Criteria**
- AC1: given an unauthenticated user navigates to the Eve Chat UI, when the page loads, then the user is redirected to a Google sign-in prompt
- AC2: given a user completes Google sign-in with the email cuillinguy@gmail.com, when authentication finishes, then the user is granted access to the Eve Chat UI
`;

  it("approves a valid full-stack plan matching story domain and ACs", () => {
    const result = validateExecutionPlan(basePlan, sampleStoryText);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects plan with empty targetFiles", () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      targetFiles: [],
    };
    const result = validateExecutionPlan(plan, sampleStoryText);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Plan must specify at least one target file.");
  });

  it("rejects plan with path traversal in target files", () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      targetFiles: [
        {
          path: "../outside/file.ts",
          action: "modify",
          rationale: "illegal path",
        },
      ],
    };
    const result = validateExecutionPlan(plan, sampleStoryText);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("path traversal"))).toBe(true);
  });

  it("rejects UI/Chat story when targetFiles omit app/ or components/ entrypoints", () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      targetFiles: [
        {
          path: "agent/google-auth.ts",
          action: "create",
          rationale: "Pure helper file only",
        },
        {
          path: "tests/google-auth.test.ts",
          action: "create",
          rationale: "Unit test file",
        },
      ],
    };
    const result = validateExecutionPlan(plan, sampleStoryText);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("UI/Chat story must modify or create files under app/ or components/"),
      ),
    ).toBe(true);
  });

  it("rejects plan when story ACs are missing from acceptanceCriteriaMap", () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      acceptanceCriteriaMap: [
        {
          acId: "AC1",
          description: "Unauthenticated user redirect",
          testFile: "tests/chat-auth.test.ts",
          testCaseName: "redirects unauthenticated user",
        },
        // Missing AC2
      ],
    };
    const result = validateExecutionPlan(plan, sampleStoryText);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Missing test mapping for AC: AC2"))).toBe(true);
  });

  it("rejects plan when an acceptance criteria map entry is missing testFile or testCaseName", () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      acceptanceCriteriaMap: [
        {
          acId: "AC1",
          description: "Unauthenticated user redirect",
          testFile: "",
          testCaseName: "some test",
        },
        {
          acId: "AC2",
          description: "Allowed email check",
          testFile: "tests/chat-auth.test.ts",
          testCaseName: "",
        },
      ],
    };
    const result = validateExecutionPlan(plan, sampleStoryText);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("missing testFile or testCaseName")),
    ).toBe(true);
  });

  it("safely strips prototype pollution keys via safeJsonParse", async () => {
    const { safeJsonParse } = await import("../../agent/lib/dark-factory/plan-validator");
    const malicious = '{"__proto__": {"polluted": true}, "constructor": {"evil": true}, "storyId": 42}';
    const parsed = safeJsonParse<any>(malicious);
    expect(parsed.storyId).toBe(42);
    expect(({} as any).polluted).toBeUndefined();
    expect(parsed.__proto__.polluted).toBeUndefined();
  });

  it("extracts and parses plan JSON with DefaultPlanParser", async () => {
    const { DefaultPlanParser } = await import("../../agent/lib/dark-factory/plan-validator");
    const parser = new DefaultPlanParser();
    const markdownWrapped = "Here is the plan:\n```json\n" + JSON.stringify(basePlan) + "\n```\nHope this helps!";
    const res = parser.parse(markdownWrapped);
    expect(res.plan).toEqual(basePlan);
    expect(res.error).toBeUndefined();
  });
});

