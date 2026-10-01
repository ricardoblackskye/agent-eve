"use client";

import { useEffect, useState } from "react";

interface MermaidDiagramProps {
  code: string;
}

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
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

      const uniqueId = `mm-${Math.random().toString(36).substring(2, 9)}`;
      mermaid
        .render(uniqueId, code.trim())
        .then(({ svg: renderedSvg }) => {
          if (isMounted) {
            setSvg(renderedSvg);
          }
        })
        .catch((err) => {
          console.error("Mermaid render error:", err);
          if (isMounted) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
    });

    return () => {
      isMounted = false;
    };
  }, [code]);

  if (error) {
    return (
      <div className="mermaid-wrapper mermaid-error">
        <pre className="mermaid">{code}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="mermaid-wrapper mermaid-loading">
        <pre className="mermaid">{code}</pre>
      </div>
    );
  }

  return (
    <div
      className="mermaid-wrapper"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
