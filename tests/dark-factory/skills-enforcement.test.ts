import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOWED_TOOLS,
  applySkeletalMap,
  assertToolAllowed,
} from "../../agent/lib/dark-factory/developer-agent";
import { resolveCapabilities } from "../../agent/lib/dark-factory/skills";

/**
 * #157 — the capability seam reaches the enforcement points.
 *
 * `applySkeletalMap` and `assertToolAllowed` are where a capability is actually
 * refused, so a skill set is only real if these two accept it. Both take an
 * OPTIONAL capability set: absent, they behave exactly as before, which is why
 * the whole existing suite keeps passing.
 */

describe("capability enforcement (#157)", () => {
  const dirs: string[] = [];
  const mk = () => {
    const dir = mkdtempSync(join(tmpdir(), "df-skill-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length)
      rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it("refuses a .sql skeleton by DEFAULT (no skill enabled)", async () => {
    const dir = mk();
    await expect(
      applySkeletalMap(dir, { "db/migration.sql": "select 1;" }),
    ).rejects.toThrow(/disallowed extension/);
    expect(existsSync(join(dir, "db", "migration.sql"))).toBe(false);
  });

  it("accepts the same skeleton once the granting skill is enabled", async () => {
    const dir = mk();
    const capabilities = resolveCapabilities(["database-migration"]);

    await expect(
      applySkeletalMap(dir, { "db/migration.sql": "select 1;" }, capabilities),
    ).resolves.toBeUndefined();
    expect(existsSync(join(dir, "db", "migration.sql"))).toBe(true);
  });

  it("still refuses an extension no skill grants", async () => {
    const dir = mk();
    const capabilities = resolveCapabilities(["database-migration"]);
    await expect(
      applySkeletalMap(dir, { "tool.exe": "MZ" }, capabilities),
    ).rejects.toThrow(/disallowed extension/);
  });

  it("still enforces containment with capabilities in play", async () => {
    const dir = mk();
    const capabilities = resolveCapabilities(["database-migration"]);
    // Widening files types must not widen where files may be written.
    await expect(
      applySkeletalMap(dir, { "../escape.sql": "select 1;" }, capabilities),
    ).rejects.toThrow(/relative to the workspace|outside the workspace/);
  });

  it("tools: the defaults remain allowed, and a grant cannot remove one", () => {
    for (const skills of [
      [],
      ["database-migration"],
      ["shell-automation", "api-schema"],
    ]) {
      const capabilities = resolveCapabilities(skills);
      for (const tool of ALLOWED_TOOLS) {
        expect(
          () => assertToolAllowed(tool, capabilities),
          `${tool} must stay allowed`,
        ).not.toThrow();
      }
    }
  });

  it("tools: something outside the vocabulary is still refused, naming it", () => {
    expect(() =>
      assertToolAllowed("become_root", resolveCapabilities([])),
    ).toThrow(/become_root/);
    expect(() =>
      assertToolAllowed(
        "become_root",
        resolveCapabilities(["database-migration"]),
      ),
    ).toThrow(/become_root/);
  });

  it("behaves exactly as before when no capabilities are passed at all", () => {
    for (const tool of ALLOWED_TOOLS)
      expect(() => assertToolAllowed(tool)).not.toThrow();
    expect(() => assertToolAllowed("become_root")).toThrow(/become_root/);
  });
});
