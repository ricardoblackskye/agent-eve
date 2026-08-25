import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
  try {
    const rnPath = path.join(process.cwd(), "releasenotes.md");
    // Create placeholder if it doesn't exist
    if (!fs.existsSync(rnPath)) {
      fs.writeFileSync(rnPath, "# Release Notes\n\nNo release notes yet.", "utf-8");
    }
    const content = fs.readFileSync(rnPath, "utf-8");
    return new NextResponse(content, {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  } catch {
    return new NextResponse("# Release Notes\n\nNo release notes yet.", {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }
}