import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const wf = readFileSync(
  resolve(process.cwd(), ".github/workflows/preview-evals.yml"),
  "utf-8",
);

describe("Preview Evals workflow (#79)", () => {
  it("still triggers on deployment_status", () => {
    expect(wf).toMatch(/on:\s*\n\s*deployment_status:/);
  });

  it("still requires a successful deployment", () => {
    expect(wf).toMatch(/deployment_status\.state\s*==\s*'success'/);
  });

  it("excludes production deployments", () => {
    // Without this, a production merge points the job at a Vercel-auth-walled
    // URL and every eval fails with 401 before reaching the app.
    expect(wf).toMatch(/deployment_status\.environment\s*!=\s*'Production'/);
  });

  it("explains why production is excluded", () => {
    // Match the phrase plainly; a character-class regex trips cspell.
    expect(wf).toContain("Production deployments are excluded");
  });
});
