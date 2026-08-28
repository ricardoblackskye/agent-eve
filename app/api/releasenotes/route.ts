import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const GITHUB_API =
  "https://api.github.com/repos/ricardoblackskye/agent-eve/contents/releasenotes.md";

async function fetchFromGitHub(): Promise<string | null> {
  const token = process.env.GH_RELEASE_TOKEN || process.env.GITHUB_TOKEN || "";

  try {
    const headers: Record<string, string> = {
      accept: "application/vnd.github.v3+json",
    };
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    const response = await fetch(GITHUB_API, {
      headers,
      next: { revalidate: 0 },
    });
    if (!response.ok) return null;

    const data = await response.json();
    if (!data.content) return null;

    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

function fallbackToDisk(): string {
  const rnPath = path.join(process.cwd(), "releasenotes.md");
  if (fs.existsSync(rnPath)) {
    return fs.readFileSync(rnPath, "utf-8");
  }
  return "# Release Notes\n\nNo release notes yet.";
}

export async function GET() {
  try {
    // Try live GitHub content first
    const githubContent = await fetchFromGitHub();
    if (githubContent !== null) {
      return new NextResponse(githubContent, {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }

    // Fallback to local file
    const content = fallbackToDisk();
    return new NextResponse(content, {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  } catch {
    return new NextResponse("# Release Notes\n\nNo release notes yet.", {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }
}
