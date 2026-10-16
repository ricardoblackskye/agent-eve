import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The OpenRouter key is read at CALL time, not at import time (#373).
 *
 * A real local run exposed this: `createOpenAI` is called at module scope, so it captured an empty key while
 * the runner's `initEnv()` - which loads `.env` - ran after the imports had already been evaluated. Every
 * request went out unauthenticated, and the runner's own log truthfully said the key was present.
 *
 * The ordering is not reproducible in-process without stubbing the SDK's transport, so this asserts the
 * SHAPE that makes the ordering irrelevant: a function, resolved when the provider is used.
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full.split("\\").join("/"));
  }
  return out;
}

const callSites = walk("agent")
  .filter((file) => readFileSync(file, "utf8").includes("createOpenAI("))
  .map((file) => ({ file, source: readFileSync(file, "utf8") }));

describe("the model key is read at call time (#373)", () => {
  it("finds the call sites at all — a guard that matches nothing proves nothing", () => {
    expect(callSites.length).toBeGreaterThan(0);
  });

  it("hands the client a RESOLVER rather than a key captured at module scope", () => {
    for (const { file, source } of callSites) {
      expect(source, `${file}: apiKey captured at construction time`).not.toMatch(
        /apiKey:\s*process\.env\./,
      );
      expect(source, `${file}: apiKey is not a lazy resolver`).toMatch(
        /apiKey:\s*\(\s*\)\s*=>\s*process\.env\./,
      );
    }
  });
});
