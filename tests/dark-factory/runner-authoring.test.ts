import { describe, expect, it, vi } from "vitest";
import { authorFiles } from "../../scripts/dark-factory-runner";
import type { CodeAuthorProvider } from "../../agent/lib/dark-factory/code-author";

describe("authorFiles", () => {
  it("writes every authored file via the workspace tools", async () => {
    const written: Record<string, string> = {};
    const author: CodeAuthorProvider = {
      author: "in-process",
      write: async () => ({ files: { "a.ts": "x" }, raw: "r" }),
    };
    const result = await authorFiles(author, { summary: "p" }, {
      writeFile: async (p: string, c: string) => {
        written[p] = c;
      },
    } as any);
    expect(written).toEqual({ "a.ts": "x" });
    expect(result.raw).toBe("r");
  });

  it("propagates errors from author.write", async () => {
    const author: CodeAuthorProvider = {
      author: "in-process",
      write: async () => {
        throw new Error("author failed");
      },
    };
    await expect(authorFiles(author, {}, {} as any)).rejects.toThrow(
      "author failed",
    );
  });
});
