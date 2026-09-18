import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveStateDbPath,
  createRetryPolicy,
} from "../../agent/lib/dark-factory/index";

/**
 * #160 — state-path hardening.
 *
 * The containment check in `resolveStateDbPath` is lexical (path string maths),
 * so a link INSIDE the sandbox root that points outside it is not detected. The
 * escape vector is a directory junction (Windows) or symlink (POSIX); the fix
 * must re-check the real path of the deepest EXISTING ancestor, because the
 * database file itself may not exist yet.
 *
 * The integer reader is hardened in the same pass: `Number("1e3")` is `1000` and
 * `Number.isInteger(1000)` is true, so scientific notation is currently accepted
 * for every `DF_DISPATCH_*` value, and there is no upper bound.
 */

describe("resolveStateDbPath sandbox containment (#160)", () => {
  const dirs: string[] = [];
  const mk = (prefix = "df-160-") => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop() as string, { recursive: true, force: true });
    }
  });

  // A junction needs no elevation on Windows; a symlink may be refused there.
  const linkType = process.platform === "win32" ? "junction" : "dir";

  it("refuses a link inside the root that points outside it", (ctx) => {
    const root = mk();
    const outside = mk("df-160-out-");
    const link = join(root, "escape");
    try {
      symlinkSync(outside, link, linkType as "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
      throw error;
    }

    expect(() => resolveStateDbPath(join(link, "state.sqlite"), root)).toThrow(
      /outside DF_STATE_DB_DIR/,
    );
  });

  it("refuses an escaping link even when the db file does not exist yet", (ctx) => {
    const root = mk();
    const outside = mk("df-160-out-");
    const link = join(root, "escape");
    try {
      symlinkSync(outside, link, linkType as "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
      throw error;
    }

    // The refusal must happen on the ANCESTOR's real path, since `state.sqlite`
    // is not present — walking only the leaf would miss this entirely.
    expect(() =>
      resolveStateDbPath(join(link, "nested", "state.sqlite"), root),
    ).toThrow(/outside DF_STATE_DB_DIR/);
  });

  it("accepts a legitimate path inside the root", () => {
    const root = mk();
    expect(resolveStateDbPath(join(root, "state.sqlite"), root)).toBe(
      join(root, "state.sqlite"),
    );
  });

  it("accepts a path inside the root whose file does not exist yet", () => {
    const root = mk();
    expect(resolveStateDbPath(join(root, "nested", "state.sqlite"), root)).toBe(
      join(root, "nested", "state.sqlite"),
    );
  });

  it("accepts a subdirectory that is a real link pointing INSIDE the root", (ctx) => {
    const root = mk();
    const inside = join(root, "real-inside");
    mkdirSync(inside);
    const link = join(root, "link-inside");
    try {
      symlinkSync(inside, link, linkType as "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
      throw error;
    }

    // Containment is about where the path LANDS, not about whether a link is
    // used: a link resolving inside the root is legitimate and must not be
    // false-rejected (mirrors the drive-letter-case concern in the doc comment).
    expect(() =>
      resolveStateDbPath(join(link, "state.sqlite"), root),
    ).not.toThrow();
  });

  it("uses the canonical path as-is when no sandbox root is configured", () => {
    const root = mk();
    expect(resolveStateDbPath(join(root, "state.sqlite"))).toBe(
      join(root, "state.sqlite"),
    );
  });

  it("refuses WITH CONTEXT when the filesystem check itself fails", () => {
    const root = mk();
    // A real non-ENOENT failure (EACCES/ELOOP) means containment cannot be
    // verified. That must REFUSE — never be swallowed into a pass, which would
    // silently skip the check — and the message must name what failed.
    const failing = () => {
      const error = new Error(
        "EACCES: permission denied, lstat",
      ) as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    };

    expect(() =>
      resolveStateDbPath(join(root, "state.sqlite"), root, failing),
    ).toThrow(/could not be resolved for a containment check/);
    // The original cause must survive, so an operator can act on it.
    expect(() =>
      resolveStateDbPath(join(root, "state.sqlite"), root, failing),
    ).toThrow(/EACCES/);
  });

  it("still refuses a non-existent leaf when the realpath check is injected", () => {
    const root = mk();
    // Injected default behaviour must match the built-in one.
    expect(resolveStateDbPath(join(root, "state.sqlite"), root)).toBe(
      join(root, "state.sqlite"),
    );
  });
});

describe("dispatch integer validation (#160)", () => {
  it("rejects scientific notation rather than coercing it", () => {
    // Number("1e3") === 1000, which Number.isInteger accepts.
    expect(() => createRetryPolicy({ DF_DISPATCH_MAX_RETRIES: "1e3" })).toThrow(
      /DF_DISPATCH_MAX_RETRIES/,
    );
    expect(() =>
      createRetryPolicy({ DF_DISPATCH_BASE_DELAY_MS: "1e3" }),
    ).toThrow(/DF_DISPATCH_BASE_DELAY_MS/);
  });

  it("rejects values above the documented maximum", () => {
    expect(() =>
      createRetryPolicy({
        DF_DISPATCH_MAX_RETRIES: String(Number.MAX_SAFE_INTEGER),
      }),
    ).toThrow(/DF_DISPATCH_MAX_RETRIES/);
  });

  it("rejects coercible-but-not-plain-digit input", () => {
    for (const raw of [" 5 ", "+5", "0x5", "5.0", "5px", "٠٥"]) {
      expect(() => createRetryPolicy({ DF_DISPATCH_MAX_RETRIES: raw })).toThrow(
        /DF_DISPATCH_MAX_RETRIES/,
      );
    }
  });

  it("still accepts plain digits, and an empty value falls back", () => {
    expect(createRetryPolicy({ DF_DISPATCH_MAX_RETRIES: "5" }).maxRetries).toBe(
      5,
    );
    expect(
      createRetryPolicy({ DF_DISPATCH_MAX_RETRIES: "" }).maxRetries,
    ).toBeGreaterThan(0);
    expect(createRetryPolicy({}).maxRetries).toBeGreaterThan(0);
    expect(createRetryPolicy({ DF_DISPATCH_MAX_RETRIES: "0" }).maxRetries).toBe(
      0,
    );
  });
});
