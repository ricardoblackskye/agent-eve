import { defineTool } from "eve/tools";
import { z } from "zod";
import { detectGaps, type DraftStory } from "../../../lib/story-refinement";
import { validateStory, NFR_DEFAULTS } from "../../../lib/story-schema";
import { toCanonicalPayload } from "../../../lib/backlog-provider";

/**
 * Turn a raw feature request into a structured, AI-ready user story.
 *
 * Returns either a validated story payload (status `complete`) or a list of
 * targeted clarifying questions (status `needs_clarification`). The agent must
 * ask those questions and stop — never create a story issue from a draft that
 * still has gaps.
 */
export default defineTool({
  description:
    "Turn a raw feature request into a structured, AI-ready user story. " +
    "Returns either a validated story payload (status 'complete') or a list of " +
    "targeted clarifying questions (status 'needs_clarification'). When the " +
    "status is 'needs_clarification', ask the user those questions before " +
    "calling this tool again.",
  inputSchema: z.object({
    title: z.string().min(1),
    intent: z.string().min(1),
    acceptanceCriteria: z
      .array(
        z.object({ given: z.string(), when: z.string(), then: z.string() }),
      )
      .min(1),
    examples: z
      .array(z.object({ input: z.string(), output: z.string() }))
      .min(1),
    constraints: z.array(z.string()).min(1),
    nfrs: z
      .object({
        performance: z.string().optional(),
        security: z.string().optional(),
        latency: z.string().optional(),
      })
      .optional(),
    id: z.string().optional(),
  }),
  async execute(
    input: DraftStory & { title: string; nfrs?: any; id?: string },
  ) {
    const gaps = detectGaps({
      intent: input.intent,
      acceptanceCriteria: input.acceptanceCriteria,
      examples: input.examples,
      constraints: input.constraints,
    });

    if (gaps.length > 0) {
      return {
        status: "needs_clarification" as const,
        questions: gaps.map((g) => g.question),
        gaps: gaps.map(({ field, severity, question }) => ({
          field,
          severity,
          question,
        })),
      };
    }

    const result = validateStory({
      id: input.id ?? `US-${Date.now()}`,
      title: input.title,
      intent: input.intent,
      acceptanceCriteria: input.acceptanceCriteria,
      examples: input.examples,
      constraints: input.constraints,
      nfrs: {
        performance: input.nfrs?.performance ?? NFR_DEFAULTS.performance,
        security: input.nfrs?.security ?? NFR_DEFAULTS.security,
        latency: input.nfrs?.latency ?? NFR_DEFAULTS.latency,
      },
      openQuestions: [],
    });

    if (!result.ok || !result.story) {
      return {
        status: "needs_clarification" as const,
        questions: result.errors.length > 0 ? result.errors : result.missing,
        gaps: result.missing.map((field) => ({
          field: field as any,
          severity: "blocker" as const,
          question: `The ${field} section is missing or invalid.`,
        })),
      };
    }

    return {
      status: "complete" as const,
      payload: toCanonicalPayload(result.story),
    };
  },
});
