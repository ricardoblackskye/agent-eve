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

  it("approves a plan that declares a 'replace' action for a whole-file rewrite", () => {
    // `replace` is the ONE sanctioned way to lose the old code, because it says in the plan itself
    // that the file is being rewritten. See #361.
    const plan: ExecutionPlan = {
      ...basePlan,
      targetFiles: [
        {
          path: "app/chat.tsx",
          action: "replace",
          rationale:
            "Rewrite the component from scratch under a new design; the existing code is removed by intent.",
        },
      ],
    };
    const result = validateExecutionPlan(plan, sampleStoryText);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("still rejects an action it does not understand", () => {
    const plan = {
      ...basePlan,
      targetFiles: [
        { path: "app/chat.tsx", action: "delete", rationale: "not a real action" },
      ],
    } as unknown as ExecutionPlan;
    const result = validateExecutionPlan(plan, sampleStoryText);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("action must be"))).toBe(true);
  });

  // --- #365 Task 8: the plan can express an approach -------------------------

  it("approves a plan that carries an approach and a task breakdown", () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      approach: "Read the file before writing it, then compare what is kept against what is removed.",
      tasks: [
        {
          title: "Preservation guard",
          objective: "Refuse a destructive rewrite of a modify target.",
          files: ["agent/lib/dark-factory/preservation-guard.ts"],
          steps: ["Measure the lines removed.", "Refuse past the threshold."],
          verification: "tests/dark-factory/preservation-guard.test.ts",
        },
      ],
    };
    const result = validateExecutionPlan(plan, sampleStoryText);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects a blank approach when the plan provides one", () => {
    const plan: ExecutionPlan = { ...basePlan, approach: "   " };
    const result = validateExecutionPlan(plan, sampleStoryText);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("approach"))).toBe(true);
  });

  it("rejects an empty task list when the plan provides one", () => {
    const plan: ExecutionPlan = { ...basePlan, tasks: [] };
    const result = validateExecutionPlan(plan, sampleStoryText);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("at least one task"))).toBe(true);
  });

  it("rejects a task with no title or no objective", () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      tasks: [
        { title: "", objective: "Something." },
        { title: "Named properly", objective: "  " },
      ],
    };
    const result = validateExecutionPlan(plan, sampleStoryText);
    expect(result.valid).toBe(false);
    // The message names WHICH task: "task 1" and "task 2", not a bare count.
    expect(result.errors.some((e) => e.includes("task 1") && e.includes("title"))).toBe(true);
    expect(result.errors.some((e) => e.includes("task 2") && e.includes("objective"))).toBe(true);
  });

  it("still accepts a plan that omits both, so existing plans keep working", () => {
    // Deliberate, and the reason there is no opt-out flag: the fields are OPTIONAL on the type, and the
    // architect PROMPT is what asks the model for them. Making them required here would invalidate every
    // plan already in flight and every existing fixture, for a guarantee the prompt already carries.
    const result = validateExecutionPlan(basePlan, sampleStoryText);
    expect(result.valid).toBe(true);
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

