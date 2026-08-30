import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf-8");

describe("README documents the GitHub webhook release-notes flow (issue #41)", () => {
  it("documents the webhook payload URL", () => {
    expect(readme).toContain("/api/github/webhook");
  });

  it("documents the GH_WEBHOOK_SECRET env var", () => {
    expect(readme).toContain("GH_WEBHOOK_SECRET");
  });

  it("documents the GH_RELEASE_TOKEN env var (writes releasenotes.md)", () => {
    expect(readme).toContain("GH_RELEASE_TOKEN");
  });

  it("documents subscribing to Pull request events", () => {
    expect(readme.toLowerCase()).toContain("pull request");
  });

  it("links the webhook to release-manager.config.json", () => {
    expect(readme).toContain("release-manager.config.json");
  });
});
