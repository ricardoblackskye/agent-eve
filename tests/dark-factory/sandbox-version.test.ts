/**
 * #582 (version coupling) - the CLI's version must be readable and semver-shaped so the Windows
 * program can verify it before launching a provision.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCliVersion } from "../../agent/lib/dark-factory/sandbox-version";

const pkgVersion = (JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
  version: string;
}).version;

describe("getCliVersion (#582 / version coupling)", () => {
  it("returns the package version as a semver string", () => {
    const version = getCliVersion();
    expect(version).toBe(pkgVersion);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
