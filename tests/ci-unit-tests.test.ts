import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf-8"),
) as { scripts: Record<string, string> };
const ci = readFileSync(
  resolve(process.cwd(), ".github/workflows/ci.yml"),
  "utf-8",
);
const lycheeIgnore = readFileSync(
  resolve(process.cwd(), ".lycheeignore"),
  "utf-8",
);

describe("CI unit test pipeline (#103)", () => {
  it("defines a test script that runs vitest", () => {
    expect(pkg.scripts.test).toBe("vitest run");
  });

  it("declares a unit-test job in ci.yml", () => {
    expect(ci).toMatch(/^  test:/m);
  });

  it("runs the unit tests with npm test in the CI job", () => {
    expect(ci).toMatch(/run: npm test/);
  });

  it("selects the generic adapter for CI production builds", () => {
    const buildJob = ci.split("\n  build:\n")[1]?.split("\n  evals:\n")[0] ?? "";
    expect(buildJob).toMatch(/^\s+DF_PLATFORM_PROVIDER:\s*generic\s*$/m);
  });

  it("excludes only the OAuth-protected production eval base from link crawling", () => {
    const rule = lycheeIgnore
      .replaceAll("\r", "")
      .split("\n")
      .find((line) => line.startsWith("^https://agent-eve-gold"));
    expect(rule).toBeDefined();
    expect(new RegExp(rule!).test("https://agent-eve-gold.vercel.app/")).toBe(true);
    expect(
      new RegExp(rule!).test("https://agent-eve-gold.vercel.app/docs"),
    ).toBe(false);
  });
});
