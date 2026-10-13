import { createInProcessCodeAuthor, type CodeAuthorProvider } from "./code-author";

/**
 * #281 (R2) — resolve the code AUTHOR from the environment.
 *
 * Off by default and fail-closed: `DF_CODE_AUTHOR` unset (or blank) means `in-process`, i.e. today's
 * governed `streamText` path, unchanged. There is no boolean flag, because a boolean can default open
 * while a named author cannot.
 */

export const SUPPORTED_CODE_AUTHORS = ["in-process", "agent-cli"] as const;
export const SUPPORTED_AGENT_CLI_NAMES = ["codex", "gemini", "claude"] as const;

export type AgentCli = (typeof SUPPORTED_AGENT_CLI_NAMES)[number];

/** Only the knobs this factory reads, so callers need not build a whole `ProcessEnv`. */
export interface CodeAuthorEnv {
  DF_CODE_AUTHOR?: string | undefined;
  DF_AGENT_CLI?: string | undefined;
}

export interface CodeAuthorFactoryDeps {
  /** The governed model call that the `in-process` author uses. */
  generate: (prompt: string) => Promise<string>;
}

export class CodeAuthorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeAuthorConfigError";
  }
}

export function resolveAgentCli(env: CodeAuthorEnv): AgentCli {
  const requested = (env.DF_AGENT_CLI ?? "").trim();
  // Default to an OpenAI-compatible CLI: the gateway's upstream is OpenRouter, which is
  // OpenAI-shaped, so this keeps the gateway a governed near-passthrough.
  const cli = requested === "" ? "codex" : requested;
  if ((SUPPORTED_AGENT_CLI_NAMES as readonly string[]).includes(cli)) return cli as AgentCli;
  throw new CodeAuthorConfigError(
    `Unsupported DF_AGENT_CLI '${requested}'. Supported values: ${SUPPORTED_AGENT_CLI_NAMES.join(", ")}.`,
  );
}

export function createCodeAuthorProvider(
  env: CodeAuthorEnv = {
    DF_CODE_AUTHOR: process.env.DF_CODE_AUTHOR,
    DF_AGENT_CLI: process.env.DF_AGENT_CLI,
  },
  deps: CodeAuthorFactoryDeps,
): CodeAuthorProvider {
  const requested = (env.DF_CODE_AUTHOR ?? "").trim();

  // Absence = today's behaviour. This is the fail-closed default, not a permissive one.
  if (requested === "" || requested === "in-process") {
    return createInProcessCodeAuthor(deps.generate);
  }

  if (requested === "agent-cli") {
    // Validate the CLI choice first so a bad value reports its own reason...
    resolveAgentCli(env);
    // ...then REFUSE, because this release does not ship the sandbox CLI adapter yet. Refusing is
    // the point: silently running the in-process author would contradict an explicit operator choice
    // and hide the gap behind a green run.
    throw new CodeAuthorConfigError(
      "DF_CODE_AUTHOR=agent-cli requires the sandbox CLI adapter, which this release does not ship yet. Refusing rather than silently authoring in-process.",
    );
  }

  throw new CodeAuthorConfigError(
    `Unsupported DF_CODE_AUTHOR '${requested}'. Supported values: ${SUPPORTED_CODE_AUTHORS.join(", ")}.`,
  );
}
