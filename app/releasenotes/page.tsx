"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function ReleaseNotesPage() {
  const [content, setContent] = useState("");

  useEffect(() => {
    fetch("/api/releasenotes")
      .then((r) => r.text())
      .then((md) => setContent(md));
  }, []);

  return (
    <div className="architecture-container">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}