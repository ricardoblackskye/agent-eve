import { describe, it, expect } from "vitest";
import {
  SKILLS,
  SKILL_NAMES,
  parseSkillName,
  canonicaliseSkills,
  resolveCapabilities,
  validateCatalogue,
  SkillCatalogueError,
} from "../../agent/lib/dark-factory/skills";
import {
  ALLOWED_SKELETON_EXTENSIONS,
  ALLOWED_TOOLS,
} from "../../agent/lib/dark-factory/developer-agent";

/**
 * #157 — the skill catalogue.
 *
 * A skill is a capability grant. REVIEW found that `ALLOWED_TOOLS` is the only
 * tool vocabulary in this repo (the worker protocol takes a free-form command
 * string), so a skill cannot honestly grant a *tool* — it grants additional
 * allowed file extensions, which `applySkeletalMap` refuses today.
 *
 * These tests therefore assert the two properties that keep a grant honest:
 * a grant must WIDEN (never restate a default), and it must be something this
 * repo can actually honour.
 */

describe("skill catalogue (#157)", () => {
  it("refuses an unknown skill name, naming it", () => {
    expect(() => parseSkillName("teleportation")).toThrow(/teleportation/);
    expect(() => parseSkillName("")).toThrow(/empty/i);
  });

  it("accepts every name in the catalogue", () => {
    expect(SKILL_NAMES.length).toBeGreaterThan(0);
    for (const name of SKILL_NAMES) expect(parseSkillName(name)).toBe(name);
  });

  it("every granted extension is OUTSIDE the defaults — a grant must widen", () => {
    for (const name of SKILL_NAMES) {
      const grants = SKILLS[name].grants.extensions ?? [];
      expect(
        grants.length,
        `${name} grants no extension, so it widens nothing`,
      ).toBeGreaterThan(0);
      for (const ext of grants) {
        expect(
          ALLOWED_SKELETON_EXTENSIONS.has(ext),
          `${name} grants '${ext}', which is already allowed by default — that is not a widening`,
        ).toBe(false);
      }
    }
  });

  it("every granted extension is well-formed", () => {
    for (const name of SKILL_NAMES) {
      for (const ext of SKILLS[name].grants.extensions ?? []) {
        expect(ext, `${name} grants a malformed extension`).toMatch(
          /^\.[a-z0-9]+$/,
        );
      }
    }
  });

  it("every granted tool is one this repo can honour", () => {
    for (const name of SKILL_NAMES) {
      for (const tool of SKILLS[name].grants.tools ?? []) {
        expect(
          ALLOWED_TOOLS.has(tool),
          `${name} grants unknown tool '${tool}'`,
        ).toBe(true);
      }
    }
  });

  it("refuses a catalogue entry granting a tool that cannot be honoured", () => {
    // The shape is reserved for the day a tool registry exists; until then a
    // grant naming an unknown tool would be inventing capability.
    expect(() =>
      validateCatalogue({
        bogus: { description: "x", grants: { tools: ["become_root"] } },
      }),
    ).toThrow(/become_root/);
    expect(() =>
      validateCatalogue({
        bogus: { description: "x", grants: { tools: ["become_root"] } },
      }),
    ).toThrow(SkillCatalogueError);
  });

  it("refuses a catalogue entry with no description", () => {
    expect(() =>
      validateCatalogue({
        broken: { description: "  ", grants: { extensions: [".sql"] } },
      }),
    ).toThrow(/description/i);
  });

  it("canonicalises for a stable stored form (dedupe + sorted)", () => {
    expect(
      canonicaliseSkills([
        "shell-automation",
        "database-migration",
        "shell-automation",
      ]),
    ).toEqual(["database-migration", "shell-automation"]);
  });

  it("refuses to canonicalise an unknown name", () => {
    expect(() => canonicaliseSkills(["database-migration", "nope"])).toThrow(
      /nope/,
    );
  });
});

describe("resolveCapabilities (#157)", () => {
  it("with no skills returns EXACTLY the defaults — no accidental widening", () => {
    const caps = resolveCapabilities([]);
    expect([...caps.extensions].sort()).toEqual(
      [...ALLOWED_SKELETON_EXTENSIONS].sort(),
    );
    expect([...caps.tools].sort()).toEqual([...ALLOWED_TOOLS].sort());
  });

  it("widens by UNION, never by replacement", () => {
    const caps = resolveCapabilities(["database-migration"]);
    expect(caps.extensions.has(".sql")).toBe(true);
    // The defaults must survive: a skill adds capability, it does not swap it.
    for (const ext of ALLOWED_SKELETON_EXTENSIONS)
      expect(caps.extensions.has(ext)).toBe(true);
    for (const tool of ALLOWED_TOOLS) expect(caps.tools.has(tool)).toBe(true);
  });

  it("is monotonic: adding a skill never removes a granted extension", () => {
    const one = resolveCapabilities(["database-migration"]);
    const two = resolveCapabilities(["database-migration", "shell-automation"]);
    for (const ext of one.extensions)
      expect(two.extensions.has(ext)).toBe(true);
  });

  it("never widens tools today, because no registry exists to honour one", () => {
    const caps = resolveCapabilities([...SKILL_NAMES]);
    expect([...caps.tools].sort()).toEqual([...ALLOWED_TOOLS].sort());
  });
});
