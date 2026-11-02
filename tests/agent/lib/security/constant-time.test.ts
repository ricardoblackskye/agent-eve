import { describe, it, expect } from "vitest";
import { constantTimeEqual } from "../../../../agent/lib/security/constant-time";

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("secret-value", "secret-value")).toBe(true);
  });

  it("returns false for a same-length mismatch", () => {
    expect(constantTimeEqual("secret-value", "secret-valueX")).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    // node:crypto timingSafeEqual throws on unequal buffer lengths; the guard
    // must reject a length mismatch itself so callers never see that error.
    expect(constantTimeEqual("short", "a-much-longer-value")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("treats a missing value as not equal to a present one", () => {
    expect(constantTimeEqual("present", "")).toBe(false);
  });
});
