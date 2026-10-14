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

/**
 * #282 (R3) — the credential-proxy gate on the sandbox SPEC.
 *
 * The sandbox must request the credential proxy ONLY when the operator opts in. An unset (or blank)
 * gate keeps today's behaviour, and the flag is never silently enabled: a deployment that did not ask
 * for the vault path must not have secrets injected into its sandboxes.
 */
describe("#282 R3 credential-proxy gate", () => {
  /** Creates a sandbox through the provider and returns the spec the driver handed to the API. */
  const specForGate = async (gate: string | undefined) => {
    const { handle } = fakeHandle();
    const createSandbox = vi.fn(async (_spec: SandboxCreateSpec) => handle);
    const provider = createOpenSandboxProvider(
      gate === undefined ? env : { ...env, DF_SANDBOX_VAULT_ENABLED: gate },
      { createSandbox },
    );
    await provider.create("/workspace").readFile("a.ts");
    return createSandbox.mock.calls[0]![0] as unknown as {
      credentialProxy?: unknown;
    };
  };

  it("requests the credential proxy when the gate is set", async () => {
    expect((await specForGate("1")).credentialProxy).toEqual({ enabled: true });
  });

  it("omits the credential proxy when the gate is unset (default closed)", async () => {
    expect((await specForGate(undefined)).credentialProxy).toBeUndefined();
  });

  it("treats a blank gate value as off", async () => {
    expect((await specForGate("   ")).credentialProxy).toBeUndefined();
  });
});

/**
 * #354 — in-sandbox git on the VAULT path.
 *
 * The sidecar injects the Authorization header for the matched repo path, so the sandbox runs a bare
 * `git push` with NO credential of its own. Two properties matter and are pinned here: the capability
 * exists ONLY when the operator opted in, and the arguments cannot escape into the sandbox shell.
 */
describe("#282 R3 in-sandbox git (vault path)", () => {
  const vaultEnv = { ...env, DF_SANDBOX_VAULT_ENABLED: "1" };
  const repoUrl = "https://github.com/ricardoblackskye/agent-eve.git";

  const vaultProvider = (handle: SandboxHandle) =>
    createOpenSandboxProvider(vaultEnv, { createSandbox: async () => handle });

  it("exposes NO git capability when the gate is off (today's host-side push)", () => {
    const provider = createOpenSandboxProvider(env, { createSandbox: vi.fn() });
    expect(provider.runGit).toBeUndefined();
  });

  it("runs git INSIDE the sandbox on the vault path, never prompting for credentials", async () => {
    const { handle, calls } = fakeHandle();
    const provider = vaultProvider(handle);
    expect(typeof provider.runGit).toBe("function");
    const res = await provider.runGit!(["push", repoUrl, "feat/df-sandbox-vault-push-354"]);
    expect(res.exitCode).toBe(0);
    // A bare URL with no userinfo, and a non-interactive git: nothing to leak, nothing to prompt for.
    expect(calls.run).toEqual([
      `GIT_TERMINAL_PROMPT=0 git push ${repoUrl} feat/df-sandbox-vault-push-354`,
    ]);
    expect(calls.run[0]).not.toContain("@");
  });

  it("rejects an argument carrying shell metacharacters BEFORE running anything", async () => {
    const { handle, calls } = fakeHandle();
    const provider = vaultProvider(handle);
    await expect(
      provider.runGit!(["push", `${repoUrl}; rm -rf /workspace`]),
    ).rejects.toThrow();
    await expect(provider.runGit!(["push", "$(whoami)"])).rejects.toThrow();
    expect(calls.run).toEqual([]);
  });
});
