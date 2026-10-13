import { buildCodeAuthorPrompt, type CodeAuthorProvider, type CodeAuthorResult, type CodeAuthorTask } from "./code-author";
import type { WorkspaceTools } from "./developer-agent";
import type { SandboxProvider } from "./sandbox";

/**
 * #281 (R2) T5 — the `agent-cli` author: a coding-agent CLI authors INSIDE the sandbox.
 *
 * The CLI's model calls are routed back through our governed gateway by overriding its base-URL knob and
 * giving it a per-run LEASE as its credential. This module never receives the provider key, so it cannot
 * leak it.
 *
 * The CLI's exact invocation is deliberately NOT hardcoded: flags and non-interactive behaviour vary by
 * version (the issue lists this as a risk), so the template is operator-supplied and its absence is a
 * REFUSAL. That keeps this module's mechanism testable while leaving the CLI-specific detail verifiable.
 */

export type AgentCliName = "codex" | "gemini" | "claude";

export interface AgentCliDescriptor {
  /** Env var the CLI reads for its provider base URL: this is what routes calls through the gateway. */
  baseUrlEnv: string;
  /** Env var the CLI presents as its credential. It carries the LEASE, never a provider key. */
  apiKeyEnv: string;
}

export const AGENT_CLI_ENV: Record<AgentCliName, AgentCliDescriptor> = {
  codex: { baseUrlEnv: "OPENAI_BASE_URL", apiKeyEnv: "OPENAI_API_KEY" },
  gemini: { baseUrlEnv: "GOOGLE_GEMINI_BASE_URL", apiKeyEnv: "GEMINI_API_KEY" },
  claude: { baseUrlEnv: "ANTHROPIC_BASE_URL", apiKeyEnv: "ANTHROPIC_API_KEY" },
};

export class CodeAuthorCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeAuthorCliError";
  }
}

export interface AgentCliDeps {
  /** Runs a command inside the sandbox with extra environment, and reports its exit code. */
  runInSandbox(
    command: string,
    env: Record<string, string>,
  ): Promise<{ exitCode: number | undefined; output: string }>;
  /** Collects the files the CLI authored. */
  collectFiles(): Promise<Record<string, string>>;
  /** The per-run lease and the gateway base URL the CLI must use. */
  lease: { token: string; gatewayUrl: string };
  /** Operator-supplied invocation template containing `{prompt}`. */
  commandTemplate: string;
}

export function buildAgentCliCommand(template: string, prompt: string): string {
  if (!template.includes("{prompt}")) {
    throw new CodeAuthorCliError("the CLI command template must contain {prompt}");
  }
  return template.replace("{prompt}", prompt);
}

export function createAgentCliCodeAuthor(cli: AgentCliName, deps: AgentCliDeps): CodeAuthorProvider {
  const descriptor = AGENT_CLI_ENV[cli];
  return {
    author: "agent-cli",
    write: async (task: CodeAuthorTask): Promise<CodeAuthorResult> => {
      if (!deps.commandTemplate.trim()) {
        throw new CodeAuthorCliError(
          "no CLI command template is configured; refusing rather than guessing CLI flags, which vary by version",
        );
      }
      // The SAME prompt the in-process author uses, so the two backends ask the same question.
      const command = buildAgentCliCommand(deps.commandTemplate, buildCodeAuthorPrompt(task.plan));
      // The CLI is pointed at OUR gateway and carries a lease. No provider key is available here to
      // leak, and the call is governed at the gateway regardless of what the CLI believes.
      const env = {
        [descriptor.baseUrlEnv]: deps.lease.gatewayUrl,
        [descriptor.apiKeyEnv]: deps.lease.token,
      };
      const execution = await deps.runInSandbox(command, env);
      if (execution.exitCode !== 0) {
        // A CLI that failed did not author code. Reporting its partial output as success is how a run
        // claims progress it never made.
        throw new CodeAuthorCliError(
          `the ${cli} CLI exited ${execution.exitCode === undefined ? "without a status" : execution.exitCode}; treating this as a failed authoring`,
        );
      }
      return { files: await deps.collectFiles(), raw: execution.output };
    },
  };
}

/**
 * Run work against a sandbox, releasing it whatever happens.
 *
 * One sandbox per run (cold start is expensive), and dispose runs on success AND on throw: closing a
 * sandbox client does not terminate the sandbox, so a missed dispose is a leak and spend.
 */
export async function withSandbox<T>(
  provider: SandboxProvider,
  fn: (tools: WorkspaceTools) => Promise<T>,
  workspaceDir = "",
): Promise<T> {
  const tools = provider.create(workspaceDir);
  try {
    return await fn(tools);
  } finally {
    // Never throws (the driver swallows teardown failures), so it cannot mask the error that caused
    // the cleanup, and it runs on success and on throw alike.
    await provider.dispose?.();
  }
}
