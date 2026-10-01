import { describe, expect, it } from "vitest";
import {
  InvalidTenantError,
  TENANT_SLUG_MAX_LENGTH,
  isTenantActive,
  newTenantId,
  normalizeRepoSlug,
  validateTenantId,
  validateTenantSlug,
} from "../../agent/lib/dark-factory/tenant";

describe("newTenantId", () => {
  it("returns an opaque UUID, not a slug or a repo name", () => {
    const id = newTenantId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toContain("/");
  });

  it("does not repeat across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTenantId()));
    expect(ids.size).toBe(50);
  });
});

describe("validateTenantId", () => {
  it("accepts a generated id", () => {
    expect(validateTenantId(newTenantId())).toBeTruthy();
  });

  it("rejects a slug used as an id", () => {
    expect(() => validateTenantId("acme-corp")).toThrow(InvalidTenantError);
  });

  it.each(["", "   ", "abc", "not-a-uuid", "12345678-1234-1234-1234-12345678901"])(
    "rejects malformed id %j",
    (bad) => {
      expect(() => validateTenantId(bad)).toThrow(InvalidTenantError);
    },
  );

  it("rejects a non-string id", () => {
    expect(() => validateTenantId(undefined as unknown as string)).toThrow(
      InvalidTenantError,
    );
  });
});

describe("validateTenantSlug", () => {
  it("accepts a lowercase hyphenated slug", () => {
    expect(validateTenantSlug("acme-corp")).toBe("acme-corp");
  });

  it.each(["", "Acme", "acme corp", "-acme", "acme_corp", "acme/corp"])(
    "rejects slug %j",
    (bad) => {
      expect(() => validateTenantSlug(bad)).toThrow(InvalidTenantError);
    },
  );

  it("rejects an over-long slug", () => {
    expect(() => validateTenantSlug("a".repeat(TENANT_SLUG_MAX_LENGTH + 1))).toThrow(
      InvalidTenantError,
    );
  });
});

describe("normalizeRepoSlug", () => {
  it("lowercases and preserves a valid owner/repo", () => {
    expect(normalizeRepoSlug("RicardoBlackSkye/agent-eve")).toBe(
      "ricardoblackskye/agent-eve",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRepoSlug("  owner/repo  ")).toBe("owner/repo");
  });

  it("preserves dots, dashes and underscores inside segments", () => {
    expect(normalizeRepoSlug("My.Org/my_repo-name.js")).toBe(
      "my.org/my_repo-name.js",
    );
  });

  it.each([
    "",
    "   ",
    "noslash",
    "a/b/c",
    "owner/",
    "/repo",
    "owner/re po",
    "owner/re$po",
    "owner/re;po",
    "owner/$(whoami)",
    "../etc/passwd",
    "..",
    ".",
    "owner/..",
    "owner/repo\nX",
    "owner/repo`id`",
  ])("rejects hostile or malformed repo %j", (bad) => {
    expect(() => normalizeRepoSlug(bad)).toThrow(InvalidTenantError);
  });

  it("rejects an over-long repo slug", () => {
    expect(() =>
      normalizeRepoSlug(`${"a".repeat(80)}/${"b".repeat(80)}`),
    ).toThrow(InvalidTenantError);
  });
});

describe("isTenantActive", () => {
  it("is true only for the active status", () => {
    expect(isTenantActive({ status: "active" })).toBe(true);
    expect(isTenantActive({ status: "inactive" })).toBe(false);
  });
});