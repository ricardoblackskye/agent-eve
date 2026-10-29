import { describe, expect, it } from "vitest";
import { runCodingPhase } from "../../scripts/dark-factory-runner";
import type { SandboxProvider } from "../../agent/lib/dark-factory/sandbox";
import type { WorkspaceTools } from "../../agent/lib/dark-factory/developer-agent";

function recordingProvider() {
  const log: string[] = [];
  const tools: WorkspaceTools = {
    writeFile: async () => {},
    readFile: async () => "",
    listFiles: async () => [],
    runTests: async () => ({ passed: true, output: "", ran: true }),
  };
  const provider = {
    driver: "local" as const,
    isolated: false,
    create: () => {
      log.push("create");
      return tools;
    },
    dispose: async () => {
      log.push("dispose");
    },
  };
  return { provider: provider as unknown as SandboxProvider, log };
}

describe("runCodingPhase", () => {
  it("disposes the sandbox after a successful phase", async () => {
    const { provider, log } = recordingProvider();
    const result = await runCodingPhase(provider, "/ws", async () => "done");
    expect(result).toBe("done");
    expect(log).toEqual(["create", "dispose"]);
  });

  it("disposes the sandbox even when the phase throws", async () => {
    const { provider, log } = recordingProvider();
    await expect(
      runCodingPhase(provider, "/ws", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(log).toEqual(["create", "dispose"]);
  });

  it("creates the sandbox exactly once per run", async () => {
    const { provider, log } = recordingProvider();
    await runCodingPhase(provider, "/ws", async () => "ok");
    expect(log.filter((x) => x === "create")).toHaveLength(1);
  });

  it("passes the created tools to the phase", async () => {
    const { provider } = recordingProvider();
    let seen: unknown;
    await runCodingPhase(provider, "/ws", async (tools) => {
      seen = tools;
      return "ok";
    });
    expect(seen).toBeDefined();
  });

  /**
   * #354 — the phase needs the PROVIDER, not just the tools, because the vault path runs its push
   * inside the phase (the sandbox is disposed the moment this returns) and `runGit` lives on the
   * provider. The cast carries the second parameter before it exists; RED is the assertion failing
   * with `undefined`.
   */
  it("hands the PROVIDER to the phase so it can use a provider capability", async () => {
    const { provider } = recordingProvider();
    let seen: unknown;
    await runCodingPhase(
      provider,
      "/ws",
      (async (_tools: WorkspaceTools, p?: unknown) => {
        seen = p;
        return "ok";
      }) as never,
    );
    expect(seen).toBe(provider);
  });
});
