import { describe, expect, it, vi } from "vitest";
import {
  createOpenSandboxProvider,
  matchesPattern,
  sandboxNetworkPolicy,
  type SandboxCreateSpec,
  type SandboxHandle,
} from "../../agent/lib/dark-factory/opensandbox-driver";

/**
 * #281 T4 — the live sandbox driver, driven with a FAKE handle so the tests need no live sandbox and
 * no credential. What matters here: the guards still fire, the egress policy is deny-by-default, and
 * teardown always happens.
 */
function fakeHandle(over: Partial<{ exitCode: number | undefined }> = {}) {
  const calls = { run: [] as string[], write: [] as { path: string; data: string }[], kill: 0, close: 0 };
  const handle: SandboxHandle = {
    id: "sbx-1",
    commands: {
      run: async (command) => {
        calls.run.push(command);
        return {
          exitCode: "exitCode" in over ? over.exitCode : 0,
          logs: { stdout: [{ text: "ok" }], stderr: [] },
        };
      },
    },
    files: {
      readFile: async (path) => `contents:${path}`,
      writeFiles: async (entries) => {
        calls.write.push(...entries);
      },
      // Mirrors the live API: entries carry `path`/`type` and NO `name`, nested files need depth,
      // and directories are returned alongside files.
      listDirectory: async () => [
        { path: "/workspace/src", type: "directory" },
        { path: "/workspace/src/b.ts", type: "file" },
        { path: "/workspace/notes.md", type: "file" },
      ],
    },
    kill: async () => {
      calls.kill += 1;
    },
    close: async () => {
      calls.close += 1;
    },
  };
  return { handle, calls };
}

const env = { DF_SANDBOX_IMAGE: "python:3.12", DF_SANDBOX_TIMEOUT_SECONDS: "600" };

describe("#281 opensandbox driver", () => {
  it("identifies as opensandbox and IS isolated", () => {
    const provider = createOpenSandboxProvider(env, { createSandbox: vi.fn() });
    expect(provider.driver).toBe("opensandbox");
    expect(provider.isolated).toBe(true);
  });

  it("creates the sandbox LAZILY, once per run, with the deny-by-default egress policy", async () => {
    const { handle } = fakeHandle();
    const createSandbox = vi.fn(async (_spec: SandboxCreateSpec) => handle);
    const provider = createOpenSandboxProvider(
      { ...env, DF_SANDBOX_EGRESS_ALLOW: "gateway.example.com" },
      { createSandbox },
    );
    const tools = provider.create("/workspace");
    expect(createSandbox).not.toHaveBeenCalled();
    await tools.readFile("a.ts");
    await tools.listFiles();
    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(createSandbox.mock.calls[0]![0]).toMatchObject({
      image: "python:3.12",
      timeoutSeconds: 600,
      networkPolicy: { defaultAction: "deny", egress: [{ action: "allow", target: "gateway.example.com" }] },
    });
  });

  it("denies all egress when none is listed (fail-closed)", () => {
    expect(sandboxNetworkPolicy({})).toEqual({ defaultAction: "deny", egress: [] });
  });

  it("rejects a disallowed extension BEFORE creating or touching the sandbox", async () => {
    const createSandbox = vi.fn();
    const tools = createOpenSandboxProvider(env, { createSandbox }).create("/workspace");
    await expect(tools.writeFile("evil.sh", "rm -rf /")).rejects.toThrow();
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("rejects a non-allowlisted test command BEFORE creating the sandbox", async () => {
    const createSandbox = vi.fn();
    const tools = createOpenSandboxProvider(env, { createSandbox }).create("/workspace");
    await expect(tools.runTests("rm -rf /")).rejects.toThrow(/not allowed|permitted/);
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("rejects paths that escape the sandbox workspace", async () => {
    const { handle } = fakeHandle();
    const tools = createOpenSandboxProvider(env, { createSandbox: async () => handle }).create("/workspace");
    await expect(tools.readFile("../escape.ts")).rejects.toThrow();
    await expect(tools.writeFile("/etc/passwd.ts", "x")).rejects.toThrow();
  });

  it("transfers files under the workspace root and filters listings by pattern", async () => {
    const { handle, calls } = fakeHandle();
    const tools = createOpenSandboxProvider(env, { createSandbox: async () => handle }).create("/workspace");
    await tools.writeFile("src/a.ts", "export const a = 1;");
    expect(calls.write).toEqual([{ path: "/workspace/src/a.ts", data: "export const a = 1;" }]);
    expect(await tools.readFile("src/a.ts")).toBe("contents:/workspace/src/a.ts");
    expect(await tools.listFiles("*.ts")).toEqual(["src/b.ts"]);
    expect(await tools.listFiles()).toEqual(["src/b.ts", "notes.md"]);
  });

  it("maps the exit code to passed, and never calls an unreadable exit code a pass", async () => {
    const good = fakeHandle();
    const goodTools = createOpenSandboxProvider(env, { createSandbox: async () => good.handle }).create("/workspace");
    expect(await goodTools.runTests("npx vitest run")).toEqual({ passed: true, output: "ok" });

    const unknown = fakeHandle({ exitCode: undefined });
    const unknownTools = createOpenSandboxProvider(env, { createSandbox: async () => unknown.handle }).create("/workspace");
    expect((await unknownTools.runTests("npm test")).passed).toBe(false);
  });

  it("kills and closes on dispose, exactly once, and never throws", async () => {
    const { handle, calls } = fakeHandle();
    const provider = createOpenSandboxProvider(env, { createSandbox: async () => handle });
    await provider.create("/workspace").readFile("a.ts");
    await provider.dispose?.();
    expect([calls.kill, calls.close]).toEqual([1, 1]);
    await provider.dispose?.(); // idempotent
    expect([calls.kill, calls.close]).toEqual([1, 1]);

    const failing = fakeHandle();
    failing.handle.kill = async () => {
      throw new Error("kill failed");
    };
    const provider2 = createOpenSandboxProvider(env, { createSandbox: async () => failing.handle });
    await provider2.create("/workspace").readFile("a.ts");
    await expect(provider2.dispose?.()).resolves.toBeUndefined();
  });

  it("matches simple globs only", () => {
    expect(matchesPattern("*.ts", "a.ts")).toBe(true);
    expect(matchesPattern("*.ts", "a.md")).toBe(false);
    expect(matchesPattern("a?.ts", "a1.ts")).toBe(true);
  });
});
