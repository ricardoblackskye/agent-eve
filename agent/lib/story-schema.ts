import { z } from "zod";

/**
 * Canonical user-story schema.
 *
 * This is the platform-neutral representation of a user story produced by the
 * product-owner subagent. It contains NO provider-specific fields — the
 * backlog provider layer (see ./backlog-provider) is responsible for mapping
 * this to GitHub / Azure DevOps / Jira, etc.
 */

const AcceptanceCriterionSchema = z.object({
  given: z.string().min(1, "a given clause is required"),
  when: z.string().min(1, "a when clause is required"),
  then: z.string().min(1, "a then clause is required"),
});

const NfrSchema = z.object({
  performance: z.string(),
  security: z.string(),
  latency: z.string(),
});

export const UserStorySchema = z.object({
  id: z.string().min(1, "an id is required"),
  title: z.string().min(1, "a title is required"),
  intent: z
    .string()
    .min(20, "intent must be at least 20 characters (unambiguous)"),
  acceptanceCriteria: z
    .array(AcceptanceCriterionSchema)
    .min(1, "at least one acceptance criterion is required"),
  examples: z
    .array(z.object({ input: z.string(), output: z.string() }))
    .min(1, "at least one example is required"),
  constraints: z
    .array(z.string())
    .min(1)
    .refine(
      (items) => items.every((c) => /^(MUST|SHOULD|MAY)\b/i.test(c)),
      "every constraint must be a MUST/SHOULD/MAY statement",
    ),
  nfrs: NfrSchema,
  openQuestions: z.array(z.string()),
});

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type Nfr = z.infer<typeof NfrSchema>;
export type UserStory = z.infer<typeof UserStorySchema>;

export const NFR_DEFAULTS: Nfr = {
  performance: "n/a",
  security: "n/a",
  latency: "n/a",
};

export type StoryValidation = {
  ok: boolean;
  missing: string[];
  errors: string[];
  story?: UserStory;
};

/**
 * Validate a user story, returning the list of missing sections rather than a
 * bare boolean. `nfrs` is optional — when omitted we fill it with the defaults
 * so downstream code never has to null-check it.
 */
export function validateStory(input: unknown): StoryValidation {
  const requiredSections = [
    "intent",
    "acceptanceCriteria",
    "examples",
    "constraints",
  ] as const;

  const missing = requiredSections.filter((section) => {
    const value = (input as Record<string, unknown>)[section];
    if (Array.isArray(value)) return value.length === 0;
    return value === undefined || value === null || value === "";
  });

  const seeded = { ...(input as Record<string, unknown>) };
  // nfrs is optional — seed the defaults before validation so a story that
  // simply omits nfrs still parses and gets the canonical default NFRs.
  if (seeded.nfrs === undefined || seeded.nfrs === null) {
    seeded.nfrs = NFR_DEFAULTS;
  }

  const parsed = UserStorySchema.safeParse(seeded);
  if (parsed.success) {
    const story = { ...parsed.data };
    if (missing.length > 0) {
      return { ok: false, missing, errors: [] };
    }
    return { ok: true, missing: [], errors: [], story };
  }

  return {
    ok: false,
    missing,
    errors: parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    ),
  };
}
