import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
  try {
    const archPath = path.join(process.cwd(), "ARCHITECTURE.md");
    const content = fs.readFileSync(archPath, "utf-8");
    return new NextResponse(content, {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  } catch {
    return new NextResponse("# Architecture\n\nDocumentation not found.", {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }
}