import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { safeJoin, safeReadWithin } from "../../../../agent/lib/security/fs-safe";

// Containment is platform-specific: on Windows a leading-slash path is still on the
// current drive, so an "outside" target has to be a different drive; on Linux it is a
// different absolute root. Branch on the platform so the assertions mean the same thing
// in both places (CI runs Linux, this box runs Windows).
const ROOT = process.platform === "win32" ? "C:\\ws" : "/ws";
const outside = process.platform === "win32" ? join("D:\\evil", "x") : join("/etc", "passwd");

describe("safeJoin", () => {
  it("joins a segment inside the root", () => {
    expect(safeJoin(ROOT, "repo-1")).toBe(join(ROOT, "repo-1"));
  });
  it("throws when a segment escapes the root via ..", () => {
    expect(() => safeJoin(ROOT, "..", "escape")).toThrow();
  });
  it("throws when the target is outside the root", () => {
    expect(() => safeJoin(ROOT, outside)).toThrow();
  });
});

describe("safeReadWithin", () => {
  it("returns the resolved target when inside the root", () => {
    const target = join(ROOT, "repo-1", "package-lock.json");
    expect(safeReadWithin(ROOT, target)).toBe(target);
  });
  it("throws when the target escapes the root via ..", () => {
    expect(() => safeReadWithin(ROOT, join(ROOT, "..", "etc", "passwd"))).toThrow();
  });
  it("throws when the target is outside the root", () => {
    expect(() => safeReadWithin(ROOT, outside)).toThrow();
  });
});
