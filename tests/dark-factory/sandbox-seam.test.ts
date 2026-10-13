import { describe, expect, it } from "vitest";
import {
  createRefusingSandboxProvider,
  SandboxRefusedError,
} from "../../agent/lib/dark-factory/sandbox";

/**
 * #280 T1 — the refusing default is FAIL-CLOSED.
 *
 * A sandbox that cannot execute must refuse every operation and touch nothing. The danger is a
 * default that silently degrades to "no-op success", which would let a run report progress it never
 * made.
 */
describe("#280 refusing sandbox provider (fail-closed)", () => {
  it("refuses every WorkspaceTools operation", async () => {
    const provider = createRefusingSandboxProvider("sandbox is not configured");
    expect(provider.isolated).toBe(false);
    const tools = provider.create("/nonexistent-workspace");
    await expect(tools.readFile("a.ts")).rejects.toThrow(SandboxRefusedError);
    await expect(tools.writeFile("a.ts", "x")).rejects.toThrow(SandboxRefusedError);
    await expect(tools.listFiles()).rejects.toThrow(SandboxRefusedError);
    await expect(tools.runTests("npx vitest")).rejects.toThrow(SandboxRefusedError);
  });

  it("names the reason, so a misconfiguration is diagnosable", async () => {
    const tools = createRefusingSandboxProvider("driver 'remote' is not available in R1").create("/tmp");
    await expect(tools.readFile("a.ts")).rejects.toThrow(/not available in R1/);
  });
});
