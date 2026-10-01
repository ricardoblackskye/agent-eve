import { expect, test } from "@playwright/test";
import { signInAsAllowed } from "./auth";

/**
 * `/architecture` moved to `/documentation` in #234 — the 418-line
 * ARCHITECTURE.md was split into a docs/ tree. This spec now covers only the
 * back-compat contract: the old path must keep working rather than 404.
 *
 * The rendering assertions moved to `documentation.spec.ts`, because the
 * diagrams and sections they described now live on separate pages.
 */
test.describe("Architecture page (moved)", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAllowed(page);
  });

  test("redirects to the documentation index", async ({ page }) => {
    await page.goto("/architecture");

    await expect(page).toHaveURL(/\/documentation\/?$/, { timeout: 10_000 });
    await expect(
      page.getByRole("heading", { name: "Documentation", exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  });
});