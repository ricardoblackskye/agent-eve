import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The model client must not be BUILT at module scope (#373).
 *
 * A real local run exposed this: `createOpenAI({ apiKey: process.env.OPENROUTER_API_KEY })` runs while the
 * module is evaluated, and the runner loads `.env` in `initEnv()` - also at module scope, but after its own
 * imports, because ESM hoists them. So the client captured an empty key (every request went out
 * unauthenticated, and OpenRouter answered "Missing Authentication header") while the runner's own log
 * truthfully reported the key as present.
 *
 * The ordering cannot be fixed by loading earlier: a module cannot run code before its own imports, and
 * loading `.env` at module scope here would inject the developer's real environment into every test that
 * imports the runner. So the fix is to DEFER the construction to call time - and this asserts that no call
 * site constructs the client eagerly.
 *
 * NOTE: passing a resolver as `apiKey` was tried and REJECTED by tsc - this @ai-sdk/openai version types
 * `apiKey` as a string. The deferral has to be the provider construction, not the key.
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

describe("the model client is built at call time (#373)", () => {
  it("finds the call sites at all — a guard that matches nothing proves nothing", () => {
    expect(callSites.length).toBeGreaterThan(0);
  });

  it("builds no provider at module scope", () => {
    for (const { file, source } of callSites) {
      // A module-scope construction looks like `const x = createOpenAI({` at the start of a line.
      expect(source, `${file}: provider built at module scope`).not.toMatch(
        /^(?:export\s+)?const\s+\w+\s*=\s*createOpenAI\(/m,
      );
    }
  });
});
