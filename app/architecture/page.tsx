"use client";

import { useEffect, useState, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MermaidBlock {
  id: string;
  code: string;
}

export default function ArchitecturePage() {
  const [content, setContent] = useState("");
  const [mermaidBlocks, setMermaidBlocks] = useState<MermaidBlock[]>([]);
  const mermaidLoaded = useRef(false);

  useEffect(() => {
    fetch("/api/architecture")
      .then((r) => r.text())
      .then((md) => {
        // Extract and remove mermaid blocks, render them separately
        const blocks: MermaidBlock[] = [];
        let i = 0;
        const processed = md.replace(
          /```mermaid\s*\n([\s\S]*?)```/g,
          (_match, code: string) => {
            const id = `mm-${i++}`;
            blocks.push({ id, code: code.trim() });
            return `<MermaidPlaceholder id="${id}" />`;
          },
        );
        setMermaidBlocks(blocks);
        setContent(processed);

        // Load Mermaid library if not loaded
        if (!mermaidLoaded.current && blocks.length > 0) {
          mermaidLoaded.current = true;
          const script = document.createElement("script");
          script.src =
            "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
          script.onload = () => {
            (window as any).mermaid.initialize({
              theme: "dark",
              themeVariables: {
                fontFamily: "system-ui, -apple-system, sans-serif",
                primaryColor: "#1a3a5c",
                primaryTextColor: "#e5e5e5",
                primaryBorderColor: "#4a8ad4",
                lineColor: "#666",
                secondaryColor: "#1a1a2e",
                tertiaryColor: "#2d2d2d",
              },
            });
          };
          document.head.appendChild(script);
        }
      });
  }, []);

  useEffect(() => {
    // Render mermaid diagrams after DOM update
    if (mermaidBlocks.length > 0 && (window as any).mermaid) {
      const timer = setTimeout(() => {
        mermaidBlocks.forEach((block) => {
          const el = document.getElementById(block.id);
          if (el) {
            try {
              (window as any).mermaid.run({ nodes: [el] });
            } catch {
              // Mermaid may not be ready yet
            }
          }
        });
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [mermaidBlocks]);

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
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children, ...props }) => {
            // ReactMarkdown wraps code blocks in <pre>
            const child = Array.isArray(children) ? children[0] : children;
            if (child && typeof child === "object" && "props" in child) {
              const cls = (child.props as any)?.className || "";
              if (cls.includes("language-mermaid")) {
                // Mermaid blocks were already extracted — skip rendering
                return null;
              }
            }
            return <pre {...props}>{children}</pre>;
          },
        }}
      >
        {/* Replace placeholders so they don't render as text */}
        {content.replace(/<MermaidPlaceholder id="([^"]+)" \/>/g, " ")}
      </ReactMarkdown>

      {/* Render mermaid diagrams separately */}
      {mermaidBlocks.map((block) => (
        <div className="mermaid-wrapper" key={block.id}>
          <pre className="mermaid" id={block.id}>
            {block.code}
          </pre>
        </div>
      ))}
    </div>
  );
}
