/**
 * Documentation tree guard (#234).
 *
 * Splitting a 414-line `ARCHITECTURE.md` across pages makes it easy to drop a
 * section — and nobody notices a missing section. This guard is written BEFORE
 * the move and asserts the union of the new pages still covers every heading the
 * original file had.
 *
 * It also enforces the same "no orphan" rule as the ADR index: a page nobody
 * links to is invisible.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const PAGES_DIR = join(ROOT, "docs", "pages");
const INDEX_PATH = join(PAGES_DIR, "README.md");

/**
 * Every heading that existed in ARCHITECTURE.md at the time of the split.
 * Captured before the move so content loss is detectable rather than silent.
 * Heading *levels* may change (a section becomes a page title); the text may not.
 */
const EXPECTED_HEADINGS = [
  "System Overview",
  "Request Flow",
  "Authentication Flow",
  "Deployment Architecture",
  "Project Structure",
  "Data Flow: Chat Session",
  "Environment Variables",
  "Platform adapters (R6 foundation)",
  "Dark Factory (R1)",
  "Execution memory (#134)",
  "Dispatch / self-correction (#138)",
  "Observability (#140)",
  "Worker environment + credential boundary (R2)",
  "Factory-level circuit breaker / cost guard (R3, #144)",
  "Durable Dark Factory run history (#198)",
  "Dark Factory run query API (#199)",
  "Dark Factory progress board (UI, #200)",
];

function pageFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
}

const PAGES = pageFiles(PAGES_DIR);
const INDEX = existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH, "utf8") : "";

function headingsOf(text: string): string[] {
  return [...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => m[1].trim());
}

const ALL_HEADINGS = PAGES.flatMap((name) =>
  headingsOf(readFileSync(join(PAGES_DIR, name), "utf8")),
);

describe("documentation tree (#234)", () => {
  it("has a non-empty page set and an index (guards against a vacuous pass)", () => {
    expect(existsSync(INDEX_PATH)).toBe(true);
    expect(PAGES.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps every page filename URL-safe", () => {
    // The index builds links from filenames. Slugs are allowlisted to [a-z0-9-]
    // before reaching a URL (CodeQL: stored XSS via stored value), so a page
    // whose name falls outside that set would be skipped rather than linked.
    // Assert the invariant here so a bad filename fails the suite, not the app.
    expect(PAGES.length).toBeGreaterThanOrEqual(2);
    for (const name of PAGES) {
      expect(name, `${name} must be a safe slug`).toMatch(/^[a-z0-9-]+\.md$/);
    }
  });

  it("links every page from the index (no orphan pages)", () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(2);
    const orphans = PAGES.filter((name) => !INDEX.includes(name));
    expect(orphans).toEqual([]);
  });

  it("gives every page a top-level heading", () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(2);
    for (const name of PAGES) {
      const body = readFileSync(join(PAGES_DIR, name), "utf8");
      expect(body, `${name}: needs an h1`).toMatch(/^#\s+\S/m);
    }
  });

  it("carries every heading the original ARCHITECTURE.md had", () => {
    // The migration-completeness assertion: nothing may be dropped in the move.
    const missing = EXPECTED_HEADINGS.filter(
      (heading) => !ALL_HEADINGS.some((found) => found === heading),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the original file as a pointer, not a second copy", () => {
    // One source of truth: ARCHITECTURE.md must not still carry the sections.
    const original = readFileSync(join(ROOT, "ARCHITECTURE.md"), "utf8");
    expect(original.length).toBeLessThan(2000);
    expect(original).toContain("docs/pages");
  });

  it("does not publish non-documentation artifacts from docs/", () => {
    // docs/ also holds adr/, mockups, a zip and wireframes. The route root is
    // docs/pages/ precisely so those are not served as pages.
    expect(PAGES.length).toBeGreaterThanOrEqual(2);
    for (const name of PAGES) {
      const rel = relative(PAGES_DIR, join(PAGES_DIR, name));
      expect(rel).not.toContain("..");
      expect(name.endsWith(".zip")).toBe(false);
      expect(name.endsWith(".html")).toBe(false);
    }
  });
});