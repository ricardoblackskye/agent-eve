import { describe, it, expect } from "vitest";
import { isApiPath, isProtectedPath, safeNextPath } from "../app/auth-gate";

// #99: the chat UI + web pages must be gated; the OAuth routes, the GitHub
// webhook and the Eve API (own Bearer auth) must stay reachable.
describe("auth gate policy (#99)", () => {
  it("protects the chat UI and the web pages", () => {
    for (const p of ["/", "/architecture", "/releasenotes"]) {
      expect(isProtectedPath(p)).toBe(true);
    }
  });

  it("keeps the OAuth + signout routes public", () => {
    for (const p of [
      "/api/auth/google/start",
      "/api/auth/google/callback",
      "/api/auth/signout",
      "/api/auth/dev",
    ]) {
      expect(isProtectedPath(p)).toBe(false);
    }
  });

  it("keeps the GitHub webhook public (Dark Factory must not break)", () => {
    expect(isProtectedPath("/api/github/webhook")).toBe(false);
  });

  it("keeps the Eve runtime paths public (health probe + session API)", () => {
    // The Eve runtime serves /eve/* directly; /api/eve/* rewrites to it
    // server-side without forwarding cookies, and CI health-checks it.
    expect(isProtectedPath("/eve/v1/health")).toBe(false);
    expect(isProtectedPath("/eve/v1/info")).toBe(false);
    expect(isProtectedPath("/eve/v1/session/abc/stream")).toBe(false);
  });

  it("leaves the Eve API on its own Bearer auth", () => {
    expect(isProtectedPath("/api/eve/v1/info")).toBe(false);
  });

  it("allows static assets", () => {
    for (const p of [
      "/_next/static/chunk.js",
      "/favicon.ico",
      "/globals.css",
    ]) {
      expect(isProtectedPath(p)).toBe(false);
    }
  });

  it("protects other API routes by default (fail-closed)", () => {
    expect(isProtectedPath("/api/releasenotes")).toBe(true);
    expect(isProtectedPath("/api/architecture")).toBe(true);
  });

  it("classifies API paths", () => {
    expect(isApiPath("/api/x")).toBe(true);
    expect(isApiPath("/chat")).toBe(false);
  });
});

describe("safe next path (#99)", () => {
  it("allows same-site paths", () => {
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/architecture")).toBe("/architecture");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });

  it("blocks open redirects", () => {
    for (const bad of [
      "//evil.com",
      "https://evil.com",
      "http://x",
      "javascript:alert(1)",
      "\\\\evil",
    ]) {
      expect(safeNextPath(bad)).toBe("/");
    }
  });
});
