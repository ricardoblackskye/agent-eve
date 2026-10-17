import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf-8"),
) as { scripts: Record<string, string> };
const ci = readFileSync(
  resolve(process.cwd(), ".github/workflows/ci.yml"),
  "utf-8",
).split(String.fromCharCode(13)).join("");
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

  it("runs the unit tests with coverage in the CI job (#391)", () => {
    expect(ci).toMatch(/run: npm run test:coverage/);
    // Point the job at a script that actually runs the suite, so a rename cannot leave CI green while
    // running nothing, and that writes the report the gate reads - so the two cannot drift apart.
    expect(pkg.scripts["test:coverage"]).toContain("vitest run --coverage");
    expect(pkg.scripts["test:coverage"]).toContain("--outputFile.json=coverage/vitest-report.json");
  });

  it("gates the pull request on the coverage ratchet (#391)", () => {
    // The gate runs inside a block scalar, so assert the command rather than a "run:" prefix.
    expect(ci).toMatch(/npm run coverage:ratchet/);
    expect(pkg.scripts["coverage:ratchet"]).toBe("tsx scripts/coverage-ratchet.ts");
    // The gate must be able to fail the job: a ratchet step that swallows its exit code is decoration.
    expect(ci).toMatch(/exit "\$status"/);
    expect(ci).toMatch(/GITHUB_STEP_SUMMARY/);
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
