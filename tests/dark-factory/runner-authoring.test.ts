import { describe, expect, it, vi } from "vitest";
import {
  authorFiles,
  PreservationRefusedError,
} from "../../scripts/dark-factory-runner";
import type { CodeAuthorProvider } from "../../agent/lib/dark-factory/code-author";

/** A workspace whose files may be read and written; a read of a missing file throws, as fs does. */
function workspace(initial: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initial };
  const writes: string[] = [];
  return {
    files,
    writes,
    tools: {
      readFile: async (relPath: string): Promise<string> => {
        if (!(relPath in files)) throw new Error(`ENOENT: ${relPath}`);
        return files[relPath];
      },
      writeFile: async (relPath: string, content: string): Promise<void> => {
        writes.push(relPath);
        files[relPath] = content;
      },
    },
  };
}

const authorReturning = (
  files: Record<string, string>,
): CodeAuthorProvider & { seen: unknown[] } => {
  const seen: unknown[] = [];
  return {
    author: "in-process",
    seen,
    write: async (task) => {
      seen.push(task);
      return { files, raw: "raw" };
    },
  };
};

function fileOf(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

describe("authorFiles", () => {
  it("writes every authored file via the workspace tools", async () => {
    const ws = workspace();
    const author: CodeAuthorProvider = {
      author: "in-process",
      write: async () => ({ files: { "a.ts": "x" }, raw: "r" }),
    };
    const result = await authorFiles(author, { summary: "p" }, ws.tools);
    expect(ws.files).toEqual({ "a.ts": "x" });
    expect(result.raw).toBe("r");
  });

  it("propagates errors from author.write", async () => {
    const ws = workspace();
    const author: CodeAuthorProvider = {
      author: "in-process",
      write: async () => {
        throw new Error("author failed");
      },
    };
    await expect(authorFiles(author, {}, ws.tools)).rejects.toThrow(
      "author failed",
    );
  });
});

/**
 * #361 T3 — the loop refuses a destructive rewrite instead of writing it.
 *
 * The runner's worker already turns a throw from `authorFiles` into a failed iteration whose message
 * is the next iteration's context, so throwing here is what makes the loop retry INFORMED rather than
 * compounding the damage.
 */
describe("#361 authorFiles refuses a destructive rewrite", () => {
  const modifyPlan = {
    targetFiles: [{ path: "app/chat.tsx", action: "modify", rationale: "add a title" }],
  };

  it("shows the author the current content of a file it is modifying", async () => {
    const ws = workspace({ "app/chat.tsx": fileOf(40) });
    const author = authorReturning({ "app/chat.tsx": `${fileOf(40)}\n// added` });

    await authorFiles(author, modifyPlan, ws.tools);

    expect(author.seen).toHaveLength(1);
    const task = author.seen[0] as { existing?: Record<string, string> };
    expect(task.existing).toEqual({ "app/chat.tsx": fileOf(40) });
  });

  it("refuses the change that shipped, and writes nothing at all", async () => {
    const ws = workspace({ "app/chat.tsx": fileOf(75), "app/other.ts": "keep me" });
    const author = authorReturning({
      "app/chat.tsx": fileOf(15, "stub"),
      "app/other.ts": "clobbered",
    });

    await expect(authorFiles(author, modifyPlan, ws.tools)).rejects.toThrow(
      PreservationRefusedError,
    );
    // All-or-nothing: a refused iteration must not half-apply itself.
    expect(ws.writes).toEqual([]);
    expect(ws.files["app/other.ts"]).toBe("keep me");
  });

  it("names the file, both counts and the escape hatch in the refusal", async () => {
    const ws = workspace({ "app/chat.tsx": fileOf(75) });
    const author = authorReturning({ "app/chat.tsx": fileOf(15, "stub") });

    await expect(authorFiles(author, modifyPlan, ws.tools)).rejects.toThrow(
      /app\/chat\.tsx.*75.*replace/s,
    );
  });

  it("writes an additive change", async () => {
    const ws = workspace({ "app/chat.tsx": fileOf(40) });
    const author = authorReturning({ "app/chat.tsx": `${fileOf(40)}\n// added` });

    const result = await authorFiles(author, modifyPlan, ws.tools);

    expect(ws.writes).toEqual(["app/chat.tsx"]);
    expect(result.written).toEqual(["app/chat.tsx"]);
    expect(ws.files["app/chat.tsx"]).toContain("// added");
  });

  it("writes a new file that has no existing content", async () => {
    const ws = workspace();
    const author = authorReturning({ "app/new.ts": "export const a = 1;" });

    const result = await authorFiles(author, modifyPlan, ws.tools);

    expect(result.written).toEqual(["app/new.ts"]);
  });

  it("protects a file the plan did not list, since it is still an overwrite", async () => {
    // The loop writes files the plan did not predict (its own test file, for one). Those must not
    // become a loophole, so an UNLISTED path with existing content is treated as a modify.
    const ws = workspace({ "app/chat.tsx": fileOf(40), "app/unlisted.ts": fileOf(60) });
    const author = authorReturning({
      "app/chat.tsx": `${fileOf(40)}\n// added`,
      "app/unlisted.ts": fileOf(5, "stub"),
    });

    await expect(authorFiles(author, modifyPlan, ws.tools)).rejects.toThrow(
      /app\/unlisted\.ts/,
    );
    expect(ws.writes).toEqual([]);
  });

  it("permits losing the old content when the plan declares a replacement", async () => {
    const ws = workspace({ "app/chat.tsx": fileOf(75) });
    const author = authorReturning({ "app/chat.tsx": fileOf(15, "stub") });
    const replacePlan = {
      targetFiles: [
        { path: "app/chat.tsx", action: "replace", rationale: "rewrite the page" },
      ],
    };

    const result = await authorFiles(author, replacePlan, ws.tools);

    expect(result.written).toEqual(["app/chat.tsx"]);
    expect(ws.files["app/chat.tsx"]).toBe(fileOf(15, "stub"));
  });

  it("still preserves when the plan cannot be read into targets", async () => {
    // Fail CLOSED: an unreadable plan must not switch the guard off.
    const ws = workspace({ "app/chat.tsx": fileOf(75) });
    const author = authorReturning({ "app/chat.tsx": fileOf(15, "stub") });

    await expect(authorFiles(author, {}, ws.tools)).rejects.toThrow(
      PreservationRefusedError,
    );
  });
});
