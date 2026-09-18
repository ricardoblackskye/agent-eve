/**
 * Dark Factory — skill catalogue (#157).
 *
 * A skill is a **capability grant**: a named capability defined by the permission
 * delta it grants. This is the vocabulary that the skill-set surface
 * (`skill-set-surface.ts`) tunes, and that the operator gate guards.
 *
 * SCOPE, decided by REVIEW rather than assumed: `ALLOWED_TOOLS` is the only tool
 * vocabulary in this repository — a grep for tool-like names across
 * `agent/lib/dark-factory/` returns exactly its four members — and the worker
 * protocol takes a free-form command string, so there is **no registry a skill
 * could add a tool to**. A skill that claimed to grant a new tool would be
 * inventing capability that does not exist, so this catalogue does not offer that.
 *
 * What genuinely widens capability today is the **file-extension allow-list**:
 * `.sql`, `.sh`, `.graphql` and `.prisma` are refused by `applySkeletalMap`. A
 * skill granting one of those is a real, visible widening — and the refusal path
 * that proves it is already tested.
 *
 * `tools` is kept in the grant shape for the day a registry exists, and a grant
 * naming a tool this repo cannot honour is refused at catalogue load.
 */

import { ALLOWED_SKELETON_EXTENSIONS, ALLOWED_TOOLS } from "./developer-agent";

/** A malformed or dishonest catalogue entry — never a silent skip. */
export class SkillCatalogueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillCatalogueError";
  }
}

export interface SkillGrant {
  /** Extensions this grant ADDS to the allow-list. */
  readonly extensions?: readonly string[];
  /** Tools this grant adds — only meaningful once a tool registry exists. */
  readonly tools?: readonly string[];
}

export interface SkillDefinition {
  readonly description: string;
  readonly grants: SkillGrant;
}

/**
 * The catalogue. Exhaustive by construction: `SkillName` is derived from these
 * keys, so adding a skill here is the only way to add one anywhere.
 */
const SKILL_DEFINITIONS = {
  "database-migration": {
    description: "Add and edit SQL migration files.",
    grants: { extensions: [".sql"] },
  },
  "shell-automation": {
    description: "Add shell tooling scripts.",
    grants: { extensions: [".sh"] },
  },
  "api-schema": {
    description: "Add GraphQL and Prisma schema files.",
    grants: { extensions: [".graphql", ".prisma"] },
  },
} as const;

export type SkillName = keyof typeof SKILL_DEFINITIONS;

/** Stable order, so a stored set and a printed set read the same way. */
export const SKILL_NAMES = (
  Object.keys(SKILL_DEFINITIONS) as SkillName[]
).sort();

export const SKILLS: Record<SkillName, SkillDefinition> = SKILL_DEFINITIONS;

const EXTENSION_PATTERN = /^\.[a-z0-9]+$/;

/**
 * Validate a catalogue, throwing `SkillCatalogueError` on the first dishonest
 * entry. A grant must WIDEN (never restate a default) and must be honourable.
 */
export function validateCatalogue<T extends Record<string, SkillDefinition>>(
  catalogue: T,
): T {
  for (const [name, definition] of Object.entries(catalogue)) {
    if (!definition.description || !definition.description.trim()) {
      throw new SkillCatalogueError(
        `Skill '${name}' needs a description: a capability nobody can review is not a capability.`,
      );
    }
    const extensions = definition.grants?.extensions ?? [];
    const tools = definition.grants?.tools ?? [];
    if (extensions.length === 0 && tools.length === 0) {
      throw new SkillCatalogueError(
        `Skill '${name}' grants nothing, so it widens nothing.`,
      );
    }
    for (const extension of extensions) {
      if (!EXTENSION_PATTERN.test(extension)) {
        throw new SkillCatalogueError(
          `Skill '${name}' grants malformed extension '${extension}' (expected e.g. '.sql').`,
        );
      }
      if (ALLOWED_SKELETON_EXTENSIONS.has(extension)) {
        throw new SkillCatalogueError(
          `Skill '${name}' grants '${extension}', which is already allowed by default: ` +
            "a grant must widen capability, not restate it.",
        );
      }
    }
    for (const tool of tools) {
      if (!ALLOWED_TOOLS.has(tool)) {
        throw new SkillCatalogueError(
          `Skill '${name}' grants tool '${tool}', which this repo cannot honour: ` +
            "ALLOWED_TOOLS is the only tool vocabulary and there is no registry to add to.",
        );
      }
    }
  }
  return catalogue;
}

// Fail-closed at load: a broken catalogue must never reach a running factory.
validateCatalogue(SKILLS);

/** Parse a skill name, refusing anything outside the catalogue. */
export function parseSkillName(raw: string): SkillName {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new SkillCatalogueError("Skill name must not be empty.");
  }
  if (!Object.prototype.hasOwnProperty.call(SKILLS, raw)) {
    throw new SkillCatalogueError(
      `Unknown skill '${raw}'. Known skills: ${SKILL_NAMES.join(", ")}.`,
    );
  }
  return raw as SkillName;
}

/**
 * Canonical form of a set: every name validated, deduped and sorted. One form
 * means a stored set and a compared set cannot differ by ordering or repetition.
 */
export function canonicaliseSkills(skills: readonly string[]): SkillName[] {
  const unique = new Set<SkillName>();
  for (const raw of skills) unique.add(parseSkillName(raw));
  return [...unique].sort();
}

export interface Capabilities {
  readonly extensions: ReadonlySet<string>;
  readonly tools: ReadonlySet<string>;
}

/**
 * The defaults WIDENED by the enabled grants — never replaced.
 *
 * A skill adds capability; it must not be able to take it away, or a tuning
 * surface would be able to remove a capability the factory needs to function.
 */
export function resolveCapabilities(
  skills: readonly string[] = [],
): Capabilities {
  const extensions = new Set<string>(ALLOWED_SKELETON_EXTENSIONS);
  const tools = new Set<string>(ALLOWED_TOOLS);
  for (const name of canonicaliseSkills(skills)) {
    for (const extension of SKILLS[name].grants.extensions ?? []) {
      extensions.add(extension);
    }
    for (const tool of SKILLS[name].grants.tools ?? []) {
      tools.add(tool);
    }
  }
  return { extensions, tools };
}
