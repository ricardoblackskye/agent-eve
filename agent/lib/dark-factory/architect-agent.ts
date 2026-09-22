/**
 * Dark Factory — Architect Agent (#179).
 *
 * Pre-code planning agent that inspects the repository file tree, analyzes
 * the User Story and Acceptance Criteria, and synthesizes an ExecutionPlan.
 * Self-corrects via feedback loops when generated plans fail domain validation.
 */

import {
  validateExecutionPlan,
  DefaultPlanParser,
  type ExecutionPlan,
  type PlanValidationResult,
  type PlanParser,
} from "./plan-validator";

export interface ArchitectDeps {
  generateText: (prompt: string) => Promise<string>;
  listFiles: (dir: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
  planParser?: PlanParser;
  maxPlanRetries?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
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

/**
 * Process-level timer registry to ensure timers are cleared even on abrupt exit.
 */
const activeTimers = new Set<NodeJS.Timeout>();

if (typeof process !== "undefined" && typeof process.once === "function") {
  const cleanupActiveTimers = () => {
    for (const timer of activeTimers) {
      clearTimeout(timer);
    }
    activeTimers.clear();
  };
  process.once("beforeExit", cleanupActiveTimers);
  process.once("SIGTERM", cleanupActiveTimers);
  process.once("SIGINT", cleanupActiveTimers);
}

/**
 * Sorts repository files by architectural relevance so critical config and
 * UI entry points are prioritized when the context window is bounded.
 */
function sortFilesByRelevance(files: string[]): string[] {
  if (!Array.isArray(files)) return [];
  const priorityPatterns = [
    /^package\.json$/i,
    /^tsconfig.*\.json$/i,
    /^(?:app|src\/app)\//i,
    /^(?:components|src\/components)\//i,
    /^agent\//i,
    /^(?:lib|src\/lib)\//i,
  ];

  return [...files].sort((a, b) => {
    const aPriority = priorityPatterns.findIndex((re) => re.test(a));
    const bPriority = priorityPatterns.findIndex((re) => re.test(b));
    const aScore = aPriority === -1 ? 999 : aPriority;
    const bScore = bPriority === -1 ? 999 : bPriority;
    if (aScore !== bScore) {
      return aScore - bScore;
    }
    return a.localeCompare(b);
  });
}

export class ArchitectAgent {
  private parser: PlanParser;
  private maxPlanRetries: number;
  private timeoutMs: number;
  private backoffBaseMs: number;
  private sleepFn: (ms: number) => Promise<void>;

  constructor(private deps: ArchitectDeps) {
    this.maxPlanRetries = deps.maxPlanRetries ?? 2;
    this.parser = deps.planParser ?? new DefaultPlanParser();
    this.timeoutMs = deps.timeoutMs ?? 60000;
    this.backoffBaseMs = deps.backoffBaseMs ?? (process.env.NODE_ENV === "test" ? 0 : 500);
    this.sleepFn =
      deps.sleepFn ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Invokes LLM generation with a timeout guard to prevent hanging interactions.
   * Registers timers in activeTimers for process-level safety.
   */
  private async executeGenerate(prompt: string): Promise<string> {
    const generatePromise = this.deps.generateText(prompt);
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `ArchitectAgent LLM interaction timed out after ${this.timeoutMs}ms.`,
          ),
        );
      }, this.timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      activeTimers.add(timer);
    });

    try {
      return await Promise.race([generatePromise, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
        activeTimers.delete(timer);
      }
    }
  }


  /**
   * Constructs the initial planning prompt for the LLM.
   */
  private buildInitialPrompt(story: StoryInput, repoFiles: string[]): string {
    const sortedFiles = sortFilesByRelevance(repoFiles);
    const safeFiles = sortedFiles.slice(0, 100);
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
    // 0. Fail-closed input validation for StoryInput
    if (!story || typeof story !== "object") {
      return {
        ok: false,
        retries: 0,
        error: "StoryInput must be a valid non-null object.",
      };
    }
    if (typeof story.number !== "number" || isNaN(story.number) || story.number <= 0) {
      return {
        ok: false,
        retries: 0,
        error: "StoryInput number must be a positive integer.",
      };
    }
    if (!story.title || typeof story.title !== "string" || !story.title.trim()) {
      return {
        ok: false,
        retries: 0,
        error: "StoryInput title must be a non-empty string.",
      };
    }
    if (!story.body || typeof story.body !== "string" || !story.body.trim()) {
      return {
        ok: false,
        retries: 0,
        error: "StoryInput body must be a non-empty string.",
      };
    }

    const repoFiles = await this.deps.listFiles(".");
    let retries = 0;
    let lastOutput = "";
    let lastErrors: string[] = [];

    let currentPrompt = this.buildInitialPrompt(story, repoFiles);

    while (true) {
      try {
        lastOutput = await this.executeGenerate(currentPrompt);
      } catch (err: any) {
        lastErrors = [err.message];
        lastOutput = "";
      }

      if (lastOutput) {
        const parseResult = this.parser.parse(lastOutput);
        if (!parseResult.plan) {
          lastErrors = [
            parseResult.error ?? "Failed to parse valid JSON from LLM response.",
          ];
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
      }

      // Allow up to maxPlanRetries self-correction loops (< condition)
      if (retries < this.maxPlanRetries) {
        retries++;
        if (this.backoffBaseMs > 0) {
          const delay = this.backoffBaseMs * Math.pow(2, retries - 1);
          await this.sleepFn(delay);
        }
        currentPrompt = this.buildRepairPrompt(story, lastOutput, {
          valid: false,
          errors: lastErrors,
        });
      } else {
        break;
      }
    }

    return {
      ok: false,
      retries,
      error: `ArchitectAgent exceeded max retries (${this.maxPlanRetries}). Errors: ${lastErrors.join("; ")}`,
    };
  }
}

