import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { listReferencePages } from "./reference/generators";

/**
 * Documentation index (#234). A server component: the pages are read from disk at
 * build time, so there is no client round-trip and no empty flash before hydration
 * — which the previous `/architecture` page had.
 */
const PAGES_DIR = path.join(process.cwd(), "docs", "pages");

type DocPage = { slug: string; title: string };

function listPages(): DocPage[] {
  return fs
    .readdirSync(PAGES_DIR)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .flatMap((name) => {
      // Allowlist the slug before it reaches a URL. A file whose name falls
      // outside [a-z0-9-] is skipped rather than rendered, so no filename-derived
      // value can be reflected into an href (CodeQL: stored XSS via stored value).
      const slug = name.replace(/\.md$/, "");
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return [];
      }
      const body = fs.readFileSync(path.join(PAGES_DIR, name), "utf8");
      const title = /^#\s+(.+?)\s*$/m.exec(body)?.[1]?.trim() ?? slug;
      return [{ slug, title }];
    });
}

export default function DocumentationIndex() {
  return (
    <div className="architecture-container">
      <h1>Documentation</h1>
      <p>
        How the Agent Eve Dark Factory fits together. Design decisions live in the{" "}
        <a href="https://github.com/ricardoblackskye/agent-eve/tree/main/docs/adr">
          Architecture Decision Records
        </a>
        .
      </p>
      <ul className="documentation-index">
        {listPages().map((page) => (
          <li key={page.slug}>
            <Link href={`/documentation/${encodeURIComponent(page.slug)}`}>{page.title}</Link>
          </li>
        ))}
      </ul>
      <h2>Generated reference</h2>
      <p>
        These pages are derived from the source of truth at build time (see ADR 0012) —
        they update automatically when the code changes, so there is no copy to drift.
      </p>
      <ul className="documentation-index">
        {listReferencePages().map((page) => (
          <li key={page.slug}>
            <Link href={`/documentation/${encodeURIComponent(page.slug)}`}>{page.title}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
