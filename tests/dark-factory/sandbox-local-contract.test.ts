import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createWorkspaceTools } from "../../agent/lib/dark-factory/developer-agent";
import { createSandboxProvider } from "../../agent/lib/dark-factory/sandbox-provider";

/**
 * #280 T3 — the local driver is BEHAVIOUR-PRESERVING, tested through the seam itself (not a mock
 * of it), and every existing security guard still fires through the seam.
 */
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "df-sandbox-"));
  dirs.push(dir);
  return dir;
}
const local = () => createSandboxProvider({ DF_SANDBOX_DRIVER: "local" });

describe("#280 local sandbox contract, through the seam", () => {
  it("reads, writes and lists within the workspace directory", async () => {
    const tools = local().create(workspace());
    await tools.writeFile("a.ts", "export const a = 1;\n");
    expect(await tools.readFile("a.ts")).toContain("export const a");
    expect(await tools.listFiles()).toContain("a.ts");
  });

  it("is byte-for-byte the same workspace as createWorkspaceTools", async () => {
    const dir = workspace();
    const viaSeam = local().create(dir);
    const direct = createWorkspaceTools(dir);
    await viaSeam.writeFile("same.ts", "value");
    expect(await direct.readFile("same.ts")).toBe("value");
    await direct.writeFile("other.ts", "other");
    expect(await viaSeam.readFile("other.ts")).toBe("other");
  });

  it("still rejects path traversal", async () => {
    const tools = local().create(workspace());
    await expect(tools.readFile("../outside.ts")).rejects.toThrow(/outside|relative|traversal/i);
  });

  it("still rejects a disallowed file extension, writing nothing", async () => {
    const dir = workspace();
    const tools = local().create(dir);
    await expect(tools.writeFile("evil.sh", "rm -rf /")).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("still rejects a non-allowlisted test command", async () => {
    const tools = local().create(workspace());
    await expect(tools.runTests("rm -rf /")).rejects.toThrow(/not allowed|permitted/i);
  });
});
