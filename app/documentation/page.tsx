import fs from "node:fs";
import path from "node:path";
import Link from "next/link";

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
    .map((name) => {
      const body = fs.readFileSync(path.join(PAGES_DIR, name), "utf8");
      const title = /^#\s+(.+?)\s*$/m.exec(body)?.[1]?.trim() ?? name;
      return { slug: name.replace(/\.md$/, ""), title };
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
            <Link href={`/documentation/${page.slug}`}>{page.title}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
