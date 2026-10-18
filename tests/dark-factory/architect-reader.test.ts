import { describe, expect, it } from "vitest";
import { createBoundedReader, type BoundedReaderLimits } from "../../agent/lib/dark-factory/architect-agent";

/**
 * #381 R1 AC1 / AC5 - the Architect may read file CONTENTS, within a budget it cannot exceed.
 *
 * Two properties matter beyond "it reads": a truncated read must SAY it is truncated (an Architect that
 * believes it has seen a whole file reasons as confidently from a fragment), and a path that is not safely
 * inside the workspace must never reach the reader at all.
 */
const LIMITS: BoundedReaderLimits = { maxFiles: 3, maxCharsPerFile: 1_000, maxTotalChars: 3_000 };

/** A spy that records every path that actually reached the underlying reader. */
function spy(files: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    readFile: async (path: string) => {
      calls.push(path);
      return files[path] ?? "";
    },
  };
}

const longFile = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");

describe("createBoundedReader (#381 R1)", () => {
  it("reads a file and reports it as whole when it fits", async () => {
    const { readFile } = spy({ "src/a.ts": "export const a = 1;" });
    const result = await createBoundedReader(readFile, LIMITS).read("src/a.ts");
    expect(result?.text).toBe("export const a = 1;");
    expect(result?.truncated).toBe(false);
    expect(result?.originalChars).toBe("export const a = 1;".length);
  });

  it("truncates a large file on a LINE boundary and says it is truncated", async () => {
    const content = longFile(300); // well over maxCharsPerFile
    const { readFile } = spy({ "src/big.ts": content });
    const result = await createBoundedReader(readFile, LIMITS).read("src/big.ts");

    expect(result?.truncated).toBe(true);
    expect(result?.originalChars).toBe(content.length);
    expect(result!.text.length).toBeLessThanOrEqual(LIMITS.maxCharsPerFile);
    // The cut must fall between lines: the last line taken is complete, never half a line.
    expect(content.startsWith(result!.text)).toBe(true);
    expect(result!.text.endsWith("\n")).toBe(true);
  });

  it("stops reading once the file budget is spent", async () => {
    const { readFile, calls } = spy({
      "a.ts": "a",
      "b.ts": "b",
      "c.ts": "c",
      "d.ts": "d",
    });
    const reader = createBoundedReader(readFile, { ...LIMITS, maxFiles: 2 });

    expect((await reader.read("a.ts"))?.text).toBe("a");
    expect((await reader.read("b.ts"))?.text).toBe("b");
    // Over budget: no read, and the underlying reader is not called again.
    expect(await reader.read("c.ts")).toBeUndefined();
    expect(await reader.read("d.ts")).toBeUndefined();
    expect(calls).toEqual(["a.ts", "b.ts"]);
    expect(reader.stats().filesRead).toBe(2);
  });

  it("keeps the TOTAL under budget across files", async () => {
    const { readFile } = spy({ "a.ts": longFile(100), "b.ts": longFile(100) });
    const reader = createBoundedReader(readFile, { ...LIMITS, maxTotalChars: 1_500 });

    const first = await reader.read("a.ts");
    const second = await reader.read("b.ts");
    expect(first && second).toBeTruthy();
    expect(reader.stats().totalChars).toBeLessThanOrEqual(1_500);
    // The second read is cut to what remains rather than allowed to overshoot the total.
    expect(second!.truncated).toBe(true);
  });

  it("never passes an unsafe path to the reader, so an escape is not even attempted", async () => {
    const { readFile, calls } = spy({ "../outside.ts": "secret", "/etc/passwd": "root:" });
    const reader = createBoundedReader(readFile, LIMITS);

    for (const bad of ["../outside.ts", "../../secret.ts", "/etc/passwd", "C:/windows/x.ts", "//server/share/x.ts"]) {
      expect(await reader.read(bad)).toBeUndefined();
    }
    // Asserting NOTHING was called is the point: a read that escapes and then fails is still an attempt.
    expect(calls).toEqual([]);
  });

  it("reads a file once even when asked twice", async () => {
    const { readFile, calls } = spy({ "src/a.ts": "export const a = 1;" });
    const reader = createBoundedReader(readFile, LIMITS);
    await reader.read("src/a.ts");
    await reader.read("src/a.ts");
    expect(calls).toEqual(["src/a.ts"]);
    // A cache hit must not be charged twice against the budget either.
    expect(reader.stats().filesRead).toBe(1);
  });

  it("treats an unreadable file as nothing read, not as an empty file", async () => {
    const reader = createBoundedReader(async () => {
      throw new Error("ENOENT");
    }, LIMITS);
    expect(await reader.read("src/missing.ts")).toBeUndefined();
  });
});
