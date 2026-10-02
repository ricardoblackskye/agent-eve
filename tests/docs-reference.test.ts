/**
 * RED anchor for #235 — docs reference generators.
 *
 * Each derived page must contain a token that can ONLY come from the source of
 * truth (a real env key, a real route path, a real adapter name, a real migration
 * dir, a real inventory marker). The generators are stubbed to return "" in RED, so
 * every assertion here fails now and turns green when GREEN implements them.
 */
import { describe, it, expect } from "vitest";
import {
  listReferencePages,
  listApiRoutes,
} from "../app/documentation/reference/generators";

// Tokens that must appear in the generated markdown, drawn from real sources.
const EXPECTED_TOKENS: Record<string, string> = {
  environment: "EVE_API_KEY", // a real .env.example key
  "api-routes": "/api/github/webhook", // a real app/api route path
  "platform-seams": "sqlite", // a real adapter implementation
  migrations: "db/migrations", // the migrations directory the page enumerates
  "tests-evals": "describe", // the inventory enumerates describe blocks
};

describe("docs reference generators (#235)", () => {
  for (const page of listReferencePages()) {
    it(`generates "${page.slug}" from its source of truth`, async () => {
      const md = await page.generate();
      expect(md, `${page.slug} must not be empty`).not.toBe("");
      const token = EXPECTED_TOKENS[page.slug];
      expect(
        md,
        `${page.slug} must contain source token "${token}"`,
      ).toContain(token);
    });
  }

  it("exposes a machine-readable API-route inventory (decision #1)", () => {
    const routes = listApiRoutes();
    expect(routes, "api routes must be enumerated from app/api/**/route.ts").not.toEqual(
      [],
    );
    for (const r of routes) {
      expect(r.path.startsWith("/api/"), `${r.path} must be an /api path`).toBe(true);
      expect(Array.isArray(r.methods) && r.methods.length > 0, `${r.path} methods`).toBe(
        true,
      );
      expect(typeof r.protected, `${r.path} posture must be boolean`).toBe("boolean");
    }
  });
});
