"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./mermaid-diagram";

export default function ArchitecturePage() {
  const [content, setContent] = useState("");

  useEffect(() => {
    fetch("/api/architecture")
      .then((r) => r.text())
      .then((md) => {
        setContent(md);
      });
  }, []);

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
            // ReactMarkdown wraps code blocks in <pre>. For Mermaid diagrams,
            // unwrap <pre> so the MermaidDiagram wrapper div is rendered cleanly.
            const child = Array.isArray(children) ? children[0] : children;
            if (child && typeof child === "object" && "props" in child) {
              const cls = (child.props as any)?.className || "";
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
