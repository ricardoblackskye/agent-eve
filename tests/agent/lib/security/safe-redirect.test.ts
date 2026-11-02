import { describe, it, expect } from "vitest";
import { safeRedirect } from "../../../../agent/lib/security/safe-redirect";

describe("safeRedirect", () => {
  it("keeps a same-origin relative path", () => {
    expect(safeRedirect("https://app.example.com", "/dashboard")).toBe(
      "https://app.example.com/dashboard",
    );
  });

  it("keeps a same-origin absolute URL", () => {
    expect(safeRedirect("https://app.example.com", "https://app.example.com/ok")).toBe(
      "https://app.example.com/ok",
    );
  });

  it("fails closed to root for an off-origin absolute URL", () => {
    expect(safeRedirect("https://app.example.com", "https://evil.com/x")).toBe(
      "https://app.example.com/",
    );
  });

  it("fails closed for a protocol-relative URL", () => {
    expect(safeRedirect("https://app.example.com", "//evil.com")).toBe(
      "https://app.example.com/",
    );
  });
});
