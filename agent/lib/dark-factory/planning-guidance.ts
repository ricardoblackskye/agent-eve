/**
 * Dark Factory — planning guidance for the Architect Agent (#361, Task 7).
 *
 * The architect was asked for a flat JSON plan and nothing else, so plans arrived as a list of files
 * with one-line rationales: no approach, no task breakdown, nothing a reviewer could assess before the
 * coding loop ran. This supplies the Superpowers "writing-plans" guidance to the prompt.
 *
 * The guidance is VENDORED rather than fetched: the architect runs inside a sandbox with no outbound
 * access to GitHub, so the text has to travel with the code. `planning-guidance/writing-plans.md` holds
 * a verbatim copy with its source, commit, licence and sync instructions; this module loads it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the vendored copy came from, and how to sync it.
 *
 * Recorded in code as well as in the file's header so a test can assert the attribution exists rather
 * than trusting a comment to survive an edit.
 */
export const PLANNING_GUIDANCE_SOURCE = {
  skill: "writing-plans",
  repository: "https://github.com/obra/superpowers",
  url: "https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/writing-plans/SKILL.md",
  commit: "bb92a77741419a4ab5f06e711a283343f1ada0c3",
  release: "v7.0.0",
  licence: "MIT",
} as const;

/** The vendored copy, verbatim, including its attribution header. */
export const WRITING_PLANS_GUIDANCE: string = readFileSync(
  join(HERE, "planning-guidance", "writing-plans.md"),
  "utf8",
);

/** The leading HTML comment block(s): the attribution header, for readers rather than for the model. */
const ATTRIBUTION_HEADER = /^\s*(?:<!--[\s\S]*?-->\s*)+/;

/**
 * The guidance as it goes into the architect prompt.
 *
 * The attribution header is stripped because it is advice to maintainers ("re-fetch this URL, keep the
 * copy verbatim"), not plan-writing guidance. Everything else is passed through untouched, so the model
 * sees the upstream text rather than this repository's summary of it.
 */
export function planningGuidanceForPrompt(): string {
  return WRITING_PLANS_GUIDANCE.replace(ATTRIBUTION_HEADER, "").trim();
}
