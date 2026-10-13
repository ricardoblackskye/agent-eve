import { describe, expect, it, vi } from "vitest";
import {
  AGENT_CLI_ENV,
  buildAgentCliCommand,
  createAgentCliCodeAuthor,
  withSandbox,
} from "../../agent/lib/dark-factory/agent-cli-author";
import { buildCodeAuthorPrompt } from "../../agent/lib/dark-factory/code-author";
import type { SandboxProvider } from "../../agent/lib/dark-factory/sandbox";
import type { WorkspaceTools } from "../../agent/lib/dark-factory/developer-agent";

/**
 * #281 T5 — the agent-cli author, driven mock-first. The properties that matter: the CLI is pointed at
 * OUR gateway and given a LEASE (never a provider key), a failed CLI run is never a success, and the
 * sandbox is always released.
 */
const tools = {} as WorkspaceTools;
function deps(over: Partial<Parameters<typeof createAgentCliCodeAuthor>[1]> = {}) {
  return {
    runInSandbox: vi.fn(async () => ({ exitCode: 0, output: "authored" })),
    collectFiles: vi.fn(async () => ({ "app/a.ts": "export const a = 1;" })),
    lease: { token: "lease-abc", gatewayUrl: "https://factory.example/api/llm-gateway" },
    commandTemplate: "codex exec {prompt}",
    ...over,
  };
}
const plan = { steps: [] };

describe("#281 agent-cli author", () => {
  it("points each supported CLI at the gateway via its own base-URL and key env vars", () => {
    expect(AGENT_CLI_ENV.codex).toEqual({ baseUrlEnv: "OPENAI_BASE_URL", apiKeyEnv: "OPENAI_API_KEY" });
    expect(AGENT_CLI_ENV.gemini.baseUrlEnv).toBe("GOOGLE_GEMINI_BASE_URL");
    expect(AGENT_CLI_ENV.claude.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
  });

  it("substitutes the prompt using the SAME prompt as the in-process author", () => {
    expect(buildAgentCliCommand("run {prompt} --now", "hello")).toBe("run hello --now");
    expect(() => buildAgentCliCommand("no placeholder", "hello")).toThrow(/\{prompt\}/);
  });

  it("runs the CLI with the gateway URL and a LEASE, never a provider key", async () => {
    const runInSandbox = vi.fn(async (command: string, env: Record<string, string>) => {
      void command;
      void env;
      return { exitCode: 0, output: "authored" };
    });
    const author = createAgentCliCodeAuthor("codex", deps({ runInSandbox }));
    expect(author.author).toBe("agent-cli");
    const result = await author.write({ plan });
    const [command, env] = runInSandbox.mock.calls[0]!;
    expect(command).toBe(`codex exec ${buildCodeAuthorPrompt(plan)}`);
    expect(env).toEqual({
      OPENAI_BASE_URL: "https://factory.example/api/llm-gateway",
      OPENAI_API_KEY: "lease-abc",
    });
    expect(JSON.stringify(env)).not.toMatch(/sk-|provider/i);
    expect(result.files).toEqual({ "app/a.ts": "export const a = 1;" });
  });

  it("treats a non-zero exit as a FAILURE, never as authored code", async () => {
    const author = createAgentCliCodeAuthor("codex", deps({ runInSandbox: vi.fn(async () => ({ exitCode: 1, output: "boom" })) }));
    await expect(author.write({ plan })).rejects.toThrow(/exited 1/);
  });

  it("treats an unreadable exit code as a failure too", async () => {
    const author = createAgentCliCodeAuthor("codex", deps({ runInSandbox: vi.fn(async () => ({ exitCode: undefined, output: "" })) }));
    await expect(author.write({ plan })).rejects.toThrow();
  });

  it("refuses when no command template is supplied, rather than guessing CLI flags", async () => {
    const author = createAgentCliCodeAuthor("claude", deps({ commandTemplate: "" }));
    await expect(author.write({ plan })).rejects.toThrow(/template/);
  });

  it("withSandbox releases the sandbox on success", async () => {
    const dispose = vi.fn(async () => undefined);
    const provider = { driver: "opensandbox", isolated: true, create: () => tools, dispose } as unknown as SandboxProvider;
    const out = await withSandbox(provider, async (t) => {
      expect(t).toBe(tools);
      return "done";
    });
    expect(out).toBe("done");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("withSandbox releases the sandbox when the work THROWS, and preserves the error", async () => {
    const dispose = vi.fn(async () => undefined);
    const provider = { driver: "opensandbox", isolated: true, create: () => tools, dispose } as unknown as SandboxProvider;
    await expect(
      withSandbox(provider, async () => {
        throw new Error("authoring blew up");
      }),
    ).rejects.toThrow("authoring blew up");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
