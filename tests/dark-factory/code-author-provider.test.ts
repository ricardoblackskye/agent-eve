import { describe, expect, it, vi } from "vitest";
import {
  createCodeAuthorProvider,
  resolveAgentCli,
  SUPPORTED_AGENT_CLI_NAMES,
  SUPPORTED_CODE_AUTHORS,
} from "../../agent/lib/dark-factory/code-author-provider";

/**
 * #281 T2 — the author switch is OFF by default and fail-closed.
 *
 * Absence must mean today's behaviour, and an explicit choice we cannot honour must REFUSE rather
 * than silently downgrade: an operator who asked for the sandboxed CLI must never get a quiet
 * in-process run that reports success.
 */
const deps = { generate: vi.fn(async () => '{"app/a.ts":"export const a = 1;"}') };

describe("#281 createCodeAuthorProvider", () => {
  it("defaults to in-process when DF_CODE_AUTHOR is unset", () => {
    expect(createCodeAuthorProvider({}, deps).author).toBe("in-process");
  });

  it("treats blank or whitespace as unset", () => {
    expect(createCodeAuthorProvider({ DF_CODE_AUTHOR: "" }, deps).author).toBe("in-process");
    expect(createCodeAuthorProvider({ DF_CODE_AUTHOR: "   " }, deps).author).toBe("in-process");
  });

  it("selects in-process explicitly and authors through the governed generate", async () => {
    const provider = createCodeAuthorProvider({ DF_CODE_AUTHOR: "in-process" }, deps);
    const result = await provider.write({ plan: { steps: [] } });
    expect(result.files).toEqual({ "app/a.ts": "export const a = 1;" });
  });

  it("refuses agent-cli until the adapter exists, instead of silently authoring in-process", () => {
    expect(() =>
      createCodeAuthorProvider({ DF_CODE_AUTHOR: "agent-cli", DF_AGENT_CLI: "codex" }, deps),
    ).toThrow(/agent-cli/);
  });

  it("throws on an unknown DF_CODE_AUTHOR, naming the supported authors", () => {
    expect(() => createCodeAuthorProvider({ DF_CODE_AUTHOR: "sandbox-cli" }, deps)).toThrow(
      /Supported values: in-process, agent-cli/,
    );
  });

  it("defaults DF_AGENT_CLI to codex (OpenAI-compatible, matching the OpenRouter upstream)", () => {
    expect(resolveAgentCli({})).toBe("codex");
  });

  it("rejects an unknown DF_AGENT_CLI, naming the supported CLIs", () => {
    expect(() => resolveAgentCli({ DF_AGENT_CLI: "aider" })).toThrow(
      /Supported values: codex, gemini, claude/,
    );
  });

  it("offers only the documented values", () => {
    expect([...SUPPORTED_CODE_AUTHORS]).toEqual(["in-process", "agent-cli"]);
    expect([...SUPPORTED_AGENT_CLI_NAMES]).toEqual(["codex", "gemini", "claude"]);
  });
});
