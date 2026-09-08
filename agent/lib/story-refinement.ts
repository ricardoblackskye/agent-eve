import type { AcceptanceCriterion } from "./story-schema";

/**
 * A draft story — what the product-owner subagent produces before refinement.
 * Unlike a validated UserStory, a draft may be incomplete or vague; the
 * refinement loop surfaces the gaps as questions for a human to answer.
 */
export interface DraftStory {
  intent: string;
  acceptanceCriteria: AcceptanceCriterion[];
  examples: Array<{ input: string; output: string }>;
  constraints: string[];
  nfrs?: { performance?: string; security?: string; latency?: string };
  openQuestions?: string[];
}

export type GapField =
  "intent" | "acceptanceCriteria" | "examples" | "constraints" | "nfrs";

export interface Gap {
  field: GapField;
  severity: "blocker" | "clarify";
  question: string;
}

const VAGUE_INTENT_CHARS = 40;

function isMeasurable(criterion: AcceptanceCriterion): boolean {
  // The "then" clause should describe an observable, preferably measurable,
  // outcome. Flag criteria whose "then" is a subjective judgement ("well",
  // "better", "good") rather than an observable result.
  const then = criterion.then.toLowerCase();
  return !/\b(well|better|good|nice|ok|fine|smoothly)\b/.test(then);
}

/**
 * Detect gaps in a draft story that would block it from becoming a valid,
 * unambiguous user story. Returns one Gap per problem, each carrying a
 * human-readable question the product-owner can ask the requester.
 */
export function detectGaps(draft: DraftStory): Gap[] {
  const gaps: Gap[] = [];

  if (draft.intent.trim().length < VAGUE_INTENT_CHARS) {
    gaps.push({
      field: "intent",
      severity: "blocker",
      question: `The intent is vague ("${draft.intent.trim()}"). What specific outcome does the user need? Describe it in a full sentence (at least ${VAGUE_INTENT_CHARS} characters).`,
    });
  }

  const vagueCriteria = draft.acceptanceCriteria.filter(
    (c) => !isMeasurable(c),
  );
  if (vagueCriteria.length > 0) {
    gaps.push({
      field: "acceptanceCriteria",
      severity: "blocker",
      question: `Some acceptance criteria are not measurable: ${vagueCriteria
        .map((c) => `"${c.then}"`)
        .join(
          ", ",
        )}. Rewrite each "then" as an observable, testable outcome (e.g. "the report downloads with exactly 12 rows").`,
    });
  }

  if (draft.examples.length === 0) {
    gaps.push({
      field: "examples",
      severity: "clarify",
      question:
        "Add at least one worked example (input → output) so the behaviour is concrete.",
    });
  }

  if (draft.constraints.length === 0) {
    gaps.push({
      field: "constraints",
      severity: "clarify",
      question:
        "List any MUST/SHOULD/MAY constraints (security, compliance, performance, etc.).",
    });
  }

  // nfrs are intentionally optional on a draft — the product-owner can fill
  // them during refinement, so their absence is not a gap here.
  return gaps;
}
