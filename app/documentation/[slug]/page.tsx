import fs from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "../mermaid-diagram";

/**
 * One documentation page (#234). Reuses the markdown + Mermaid pipeline that
 * `/architecture` established — same `react-markdown`/`remark-gfm` setup and the
 * same `MermaidDiagram` component — but renders on the server.
 */
const PAGES_DIR = path.join(process.cwd(), "docs", "pages");

function slugs(): string[] {
  return fs
    .readdirSync(PAGES_DIR)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .map((name) => name.replace(/\.md$/, ""))
    .sort();
}

export function generateStaticParams() {
  return slugs().map((slug) => ({ slug }));
}

export const dynamicParams = false;

export default async function DocumentationPage({
  params,
}: {
  params: Promise<{ slug: string }> | { slug: string };
}) {
  const { slug } = await params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) notFound();

  const file = path.join(PAGES_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) notFound();
  const content = fs.readFileSync(file, "utf8");

  return (
    <div className="architecture-container">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="inline-code" {...props}>
                  {children}
                </code>
              );
            }
            const match = /language-mermaid/.exec(className || "");
            if (match) {
              return <MermaidDiagram code={String(children)} />;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children, ...props }) => {
            const child = Array.isArray(children) ? children[0] : children;
            if (child && typeof child === "object" && "props" in child) {
              const cls = (child.props as { className?: string })?.className || "";
              if (cls.includes("language-mermaid")) {
                return <>{children}</>;
              }
            }
            return <pre {...props}>{children}</pre>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
