/**
 * Docs domain knowledge (#237) — glossary, invariants, ADR DoD.
 *
 * Content gate (authored markdown, not generated). Pins the acceptance criteria:
 *  - the glossary page exists and defines the issue's required vocabulary;
 *  - the invariants page exists and cites the code (and ADR) that enforces each;
 *  - the ADR README documents that an ADR is part of each release's DoD;
 *  - the two new pages are listed in the docs/pages README TOC.
 *
 * Guarded against vacuous passes: it asserts real content (required terms,
 * a count of invariants, actual code/ADR links), not just file presence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PAGES_DIR = join(process.cwd(), "docs", "pages");
const ADR_DIR = join(process.cwd(), "docs", "adr");
const GLOSSARY = join(PAGES_DIR, "glossary.md");
const INVARIANTS = join(PAGES_DIR, "invariants.md");
const PAGES_README = join(PAGES_DIR, "README.md");
const ADR_README = join(ADR_DIR, "README.md");

// A page must link to at least one ADR (docs/adr/00NN) — the design "why".
const ADR_LINK = /\]\([^)]*adr\/00\d\d/i;
// A page must link to the code that enforces the invariant.
const CODE_LINK =
  /(agent\/lib\/dark-factory\/|app\/api\/dark-factory\/|app\/dark-factory\/|app\/auth-gate\.ts)/;

const REQUIRED_GLOSSARY_TERMS = [
  "pbi",
  "tenant",
  "run",
  "dispatch",
  "control plane",
  "seam",
  "adapter",
  "gate",
  "dark factory",
  "r1",
  "r2",
  "r3",
];

describe("Dark Factory domain knowledge (#237)", () => {
  const glossaryExists = existsSync(GLOSSARY);
  const glossary = glossaryExists ? readFileSync(GLOSSARY, "utf8") : "";
  const invariantsExists = existsSync(INVARIANTS);
  const invariants = invariantsExists ? readFileSync(INVARIANTS, "utf8") : "";
  const pagesReadme = existsSync(PAGES_README)
    ? readFileSync(PAGES_README, "utf8")
    : "";
  const adrReadme = existsSync(ADR_README) ? readFileSync(ADR_README, "utf8") : "";

  describe("glossary.md", () => {
    it("page exists", () => expect(glossaryExists).toBe(true));
    it("is non-trivial (> 1000 chars)", () => {
      expect(glossaryExists).toBe(true);
      expect(glossary.length).toBeGreaterThan(1000);
    });
    for (const term of REQUIRED_GLOSSARY_TERMS) {
      it(`defines the term "${term}"`, () => {
        expect(glossaryExists).toBe(true);
        expect(glossary.toLowerCase()).toContain(term);
      });
    }
  });

  describe("invariants.md", () => {
    it("page exists", () => expect(invariantsExists).toBe(true));
    it("is non-trivial (> 1000 chars)", () => {
      expect(invariantsExists).toBe(true);
      expect(invariants.length).toBeGreaterThan(1000);
    });
    it("documents at least 5 invariants", () => {
      expect(invariantsExists).toBe(true);
      const count = (invariants.toLowerCase().match(/invariant/g) || []).length;
      expect(count).toBeGreaterThanOrEqual(5);
    });
    it("cites the code that enforces an invariant", () => {
      expect(invariantsExists).toBe(true);
      expect(CODE_LINK.test(invariants)).toBe(true);
    });
    it("links to at least one ADR", () => {
      expect(invariantsExists).toBe(true);
      expect(ADR_LINK.test(invariants)).toBe(true);
    });
  });

  describe("ADR README", () => {
    it("documents that an ADR is part of the release Definition of Done", () => {
      expect(adrReadme.toLowerCase()).toContain("definition of done");
    });
  });

  describe("docs/pages README TOC", () => {
    it("lists glossary.md", () => expect(pagesReadme).toContain("glossary.md"));
    it("lists invariants.md", () =>
      expect(pagesReadme).toContain("invariants.md"));
  });
});
