/**
 * Dark Factory — Architect Agent (#179).
 *
 * Pre-code planning agent that inspects the repository file tree, analyzes
 * the User Story and Acceptance Criteria, and synthesizes an ExecutionPlan.
 * Self-corrects via feedback loops when generated plans fail domain validation.
 */

import {
  validateExecutionPlan,
  type ExecutionPlan,
  type PlanValidationResult,
} from "./plan-validator";

export interface ArchitectDeps {
  generateText: (prompt: string) => Promise<string>;
  listFiles: (dir: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
  maxPlanRetries?: number;
}

export interface ArchitectResult {
  ok: boolean;
  plan?: ExecutionPlan;
  retries: number;
  error?: string;
}

export interface StoryInput {
  number: number;
  title: string;
  body: string;
}

export class ArchitectAgent {
  private maxPlanRetries: number;

  constructor(private deps: ArchitectDeps) {
    this.maxPlanRetries = deps.maxPlanRetries ?? 2;
  }

  /**
   * Safely parses JSON output from LLM, stripping markdown fences if present.
   * Returns parsed plan or detailed error message.
   */
  private parsePlanJson(text: string): { plan: ExecutionPlan | null; error?: string } {
    try {
      let raw = text.trim();
      // Strip markdown code fences if present
      if (raw.startsWith("```")) {
        raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      }
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        raw = jsonMatch[0];
      }
      const plan = JSON.parse(raw) as ExecutionPlan;
      return { plan };
    } catch (err: any) {
      return {
        plan: null,
        error: `JSON parse failed: ${err.message}`,
      };
    }
  }

  /**
   * Constructs the initial planning prompt for the LLM.
   */
  private buildInitialPrompt(story: StoryInput, repoFiles: string[]): string {
    const safeFiles = Array.isArray(repoFiles) ? repoFiles.slice(0, 100) : [];
    return [
      `You are Eve's autonomous Architect Agent.`,
      `Your task is to analyze the following User Story and create a comprehensive ExecutionPlan.`,
      ``,
      `### USER STORY #${story.number}: ${story.title}`,
      story.body,
      ``,
      `### REPOSITORY STRUCTURE:`,
      `Existing files:`,
      safeFiles.map((f) => `- ${f}`).join("\n"),
      ``,
      `### EXECUTION PLAN REQUIREMENTS:`,
      `You must output a JSON object with:`,
      `- "storyId": ${story.number}`,
      `- "title": ${JSON.stringify(story.title)}`,
      `- "summary": high-level summary of architectural changes`,
      `- "targetFiles": array of { "path": string, "action": "create" | "modify", "rationale": string }`,
      `- "acceptanceCriteriaMap": array of { "acId": string, "description": string, "testFile": string, "testCaseName": string }`,
      `- "dependencies": optional array of npm packages to add`,
      ``,
      `IMPORTANT DOMAIN RULES:`,
      `- If the story touches UI/Chat (mentions "chat ui", "user navigates", "page", "browser", "screen"), targetFiles MUST include UI entrypoints under app/ or components/ (e.g. app/page.tsx, app/chat.tsx).`,
      `- Every Acceptance Criterion from the story must be mapped to an automated test file and test case name.`,
      `- Return ONLY raw JSON. No conversational text or markdown code fences.`,
    ].join("\n");
  }

  /**
   * Constructs a repair prompt including specific validation feedback.
   */
  private buildRepairPrompt(
    story: StoryInput,
    previousOutput: string,
    validation: PlanValidationResult,
  ): string {
    return [
      `You are Eve's autonomous Architect Agent.`,
      `Your previous ExecutionPlan for Story #${story.number} failed domain validation:`,
      ``,
      `### VALIDATION ERRORS:`,
      validation.errors.map((e) => `- ${e}`).join("\n"),
      ``,
      `### PREVIOUS OUTPUT:`,
      previousOutput,
      ``,
      `Please revise the ExecutionPlan to fix ALL validation errors.`,
      `Ensure appropriate targetFiles are included and all Acceptance Criteria are mapped to test files.`,
      `Return ONLY the corrected JSON object.`,
    ].join("\n");
  }

  /**
   * Explores the repository and synthesizes a validated ExecutionPlan for the story.
   * Executes 1 initial attempt plus up to maxPlanRetries self-correction cycles.
   */
  async planStory(story: StoryInput): Promise<ArchitectResult> {
    const repoFiles = await this.deps.listFiles(".");
    let retries = 0;
    let lastOutput = "";
    let lastErrors: string[] = [];

    let currentPrompt = this.buildInitialPrompt(story, repoFiles);

    while (retries <= this.maxPlanRetries) {
      lastOutput = await this.deps.generateText(currentPrompt);
      const parseResult = this.parsePlanJson(lastOutput);

      if (!parseResult.plan) {
        lastErrors = [parseResult.error ?? "Failed to parse valid JSON from LLM response."];
      } else {
        const validation = validateExecutionPlan(parseResult.plan, story.body);
        if (validation.valid) {
          return {
            ok: true,
            plan: parseResult.plan,
            retries,
          };
        }
        lastErrors = validation.errors;
      }

      retries++;
      if (retries <= this.maxPlanRetries) {
        currentPrompt = this.buildRepairPrompt(story, lastOutput, {
          valid: false,
          errors: lastErrors,
        });
      }
    }

    return {
      ok: false,
      retries: this.maxPlanRetries,
      error: `ArchitectAgent exceeded max retries (${this.maxPlanRetries}). Errors: ${lastErrors.join("; ")}`,
    };
  }
}
