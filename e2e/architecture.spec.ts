import { expect, test } from "@playwright/test";

test.describe("Architecture page", () => {
  test("loads the architecture page with title", async ({ page }) => {
    await page.goto("/architecture");

    await expect(
      page.getByRole("heading", { name: "Architecture", exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    // Page should return 200
    expect(page.url()).toContain("/architecture");
  });

  test("renders Mermaid diagrams on the page", async ({ page }) => {
    await page.goto("/architecture");

    // Mermaid diagrams should render as SVG elements
    await expect(page.locator("svg")).toBeVisible({ timeout: 15_000 });
  });

  test("contains system overview content", async ({ page }) => {
    await page.goto("/architecture");

    // Should mention the key components
    await expect(page.getByText(/Vercel/i).first()).toBeVisible();
    await expect(page.getByText(/Next\.js/i).first()).toBeVisible();
    await expect(page.getByText(/Eve/i).first()).toBeVisible();
    await expect(page.getByText(/OpenRouter/i).first()).toBeVisible();
  });
});
