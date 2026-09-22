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

  private parsePlanJson(text: string): ExecutionPlan | null {
    try {
      let raw = text.trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        raw = jsonMatch[0];
      }
      return JSON.parse(raw) as ExecutionPlan;
    } catch {
      return null;
    }
  }

  private buildInitialPrompt(story: StoryInput, repoFiles: string[]): string {
    return [
      `You are Eve's autonomous Architect Agent.`,
      `Your task is to analyze the following User Story and create a comprehensive ExecutionPlan.`,
      ``,
      `### USER STORY #${story.number}: ${story.title}`,
      story.body,
      ``,
      `### REPOSITORY STRUCTURE:`,
      `Existing files:`,
      repoFiles.slice(0, 100).map((f) => `- ${f}`).join("\n"),
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
   */
  async planStory(story: StoryInput): Promise<ArchitectResult> {
    const repoFiles = await this.deps.listFiles(".");
    let retries = 0;
    let lastOutput = "";
    let lastErrors: string[] = [];

    let currentPrompt = this.buildInitialPrompt(story, repoFiles);

    while (retries <= this.maxPlanRetries) {
      lastOutput = await this.deps.generateText(currentPrompt);
      const parsedPlan = this.parsePlanJson(lastOutput);

      if (!parsedPlan) {
        lastErrors = ["Failed to parse valid JSON from LLM response."];
      } else {
        const validation = validateExecutionPlan(parsedPlan, story.body);
        if (validation.valid) {
          return {
            ok: true,
            plan: parsedPlan,
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
