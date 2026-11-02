import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { safeJoin, safeReadWithin } from "../../../../agent/lib/security/fs-safe";

describe("safeJoin", () => {
  it("joins a segment that stays inside the root", () => {
    expect(safeJoin("/ws", "repo-1")).toBe(join("/ws", "repo-1"));
  });

  it("throws when a segment escapes the root", () => {
    expect(() => safeJoin("/ws", "../escape")).toThrow();
  });

  it("throws when the target is absolute outside the root", () => {
    expect(() => safeJoin("/ws", "/etc/passwd")).toThrow();
  });
});

describe("safeReadWithin", () => {
  it("returns the resolved target when it stays inside the root", () => {
    const target = join("/ws", "repo-1", "package-lock.json");
    expect(safeReadWithin("/ws", target)).toBe(target);
  });

  it("throws when the target is outside the root", () => {
    expect(() => safeReadWithin("/ws", "/etc/passwd")).toThrow();
  });

  it("throws when the target uses .. to climb out of the root", () => {
    expect(() => safeReadWithin("/ws", join("/ws", "..", "etc", "passwd"))).toThrow();
  });
});
