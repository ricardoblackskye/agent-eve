/**
 * Docs flow deep-dives (#236) — authored narrative pages, not generated.
 *
 * This test pins the acceptance criteria from #236:
 *  - each listed area has a page describing the flow, not just the files;
 *  - every page links to the code it describes;
 *  - every page links to at least one ADR (the "why");
 *  - the page is discoverable from the docs/pages README table of contents.
 *
 * It is deliberately a content gate, not a build dependency: the pages are
 * hand-authored markdown under docs/pages/ and are rendered by the existing
 * docs pipeline. The assertions guard against stub/empty pages and against a
 * page that forgets its code/ADR links.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PAGES_DIR = join(process.cwd(), "docs", "pages");
const README = join(PAGES_DIR, "README.md");

interface ExpectedPage {
  slug: string;
  title: string;
}

const EXPECTED: ExpectedPage[] = [
  { slug: "flow-run-lifecycle", title: "End-to-end run lifecycle" },
  { slug: "flow-control-plane", title: "Control plane and gates" },
  { slug: "flow-worker-sandbox", title: "Worker sandbox and credential boundary" },
  { slug: "flow-cost-governance", title: "Cost and usage governance" },
  { slug: "flow-tenant-attribution", title: "Tenant attribution and reporting" },
  { slug: "flow-observability", title: "Observability" },
];

// A page must link to at least one ADR (docs/adr/00NN) — the design "why".
const ADR_LINK = /\]\([^)]*adr\/00\d\d/i;
// A page must link to the code it describes.
const CODE_LINK =
  /(agent\/lib\/dark-factory\/|app\/api\/dark-factory\/|app\/dark-factory\/|app\/auth-gate\.ts)/;

describe("Dark Factory flow deep-dives (#236)", () => {
  const readme = existsSync(README) ? readFileSync(README, "utf8") : "";

  for (const { slug } of EXPECTED) {
    describe(slug, () => {
      const file = join(PAGES_DIR, `${slug}.md`);
      const exists = existsSync(file);
      const content = exists ? readFileSync(file, "utf8") : "";

      it("page file exists in docs/pages", () => {
        expect(exists).toBe(true);
      });

      it("is a non-trivial narrative (> 800 chars)", () => {
        expect(exists).toBe(true);
        expect(content.length).toBeGreaterThan(800);
      });

      it("links to at least one ADR (the 'why')", () => {
        expect(exists).toBe(true);
        expect(ADR_LINK.test(content)).toBe(true);
      });

      it("links to the code it describes", () => {
        expect(exists).toBe(true);
        expect(CODE_LINK.test(content)).toBe(true);
      });

      it("is listed in the docs/pages README TOC", () => {
        expect(readme).toContain(slug);
      });
    });
  }
});
