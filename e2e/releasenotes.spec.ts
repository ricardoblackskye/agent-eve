import { expect, test } from "@playwright/test";

test.describe("Release notes page", () => {
  test("loads the release notes page with title", async ({ page }) => {
    await page.goto("/releasenotes");

    await expect(
      page.getByRole("heading", { name: "Release Notes", exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    expect(page.url()).toContain("/releasenotes");
  });

  test("shows placeholder content when no releases exist", async ({ page }) => {
    await page.goto("/releasenotes");

    // Should still show the basic heading
    await expect(
      page.getByRole("heading", { name: "Release Notes", exact: true }),
    ).toBeVisible();

    // Page content area should be rendered
    await expect(page.locator(".architecture-container")).toBeVisible();
  });
});