import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceReader } from "../agent/lib/dark-factory/plan-workspace";

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "df-plan-ws-"));
  dirs.push(dir);
  writeFileSync(join(dir, "alpha.txt"), "alpha");
  writeFileSync(join(dir, "README.md"), "# target repo");
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "page.tsx"), "export default 1;");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "noise.js"), "noise");
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
});

describe("rooted workspace reader (issue #405)", () => {
  it("lists the workspace root's files, not the process working directory", async () => {
    const root = workspace();
    const reader = createWorkspaceReader(root);
    const files = await reader.listFiles(".");
    expect(files.sort()).toEqual(["README.md", "alpha.txt", "app/page.tsx"]);
  });

  it("scopes a listing to a subdirectory while keeping paths root-relative", async () => {
    const root = workspace();
    const files = await createWorkspaceReader(root).listFiles("app");
    expect(files).toEqual(["app/page.tsx"]);
  });

  it("skips dependency and metadata directories", async () => {
    const root = workspace();
    const files = await createWorkspaceReader(root).listFiles(".");
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("reads a file by its root-relative path", async () => {
    const root = workspace();
    const text = await createWorkspaceReader(root).readFile("app/page.tsx");
    expect(text).toBe("export default 1;");
  });

  it("REFUSES a path that escapes the workspace root", async () => {
    const root = workspace();
    await expect(createWorkspaceReader(root).readFile("../escape.txt")).rejects.toThrow();
  });

  it("REFUSES an absolute path outside the root", async () => {
    const root = workspace();
    const outside = join(tmpdir(), "df-plan-ws-outside.txt");
    writeFileSync(outside, "outside");
    try {
      await expect(createWorkspaceReader(root).readFile(outside)).rejects.toThrow();
    } finally {
      rmSync(outside, { force: true });
    }
  });
});
