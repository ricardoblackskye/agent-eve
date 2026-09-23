import { expect, test } from "@playwright/test";
import { signInAsAllowed } from "./auth";

test.describe("Architecture page", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAllowed(page);
  });

  test("loads the architecture page with title", async ({ page }) => {
    await page.goto("/architecture");

    await expect(
      page.getByRole("heading", { name: "Architecture", exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    // Page should return 200
    expect(page.url()).toContain("/architecture");
  });

  test("renders all 6 Mermaid diagrams as SVG elements", async ({ page }) => {
    await page.goto("/architecture");

    // All 6 Mermaid diagrams in ARCHITECTURE.md should render as SVG elements inside .mermaid-wrapper
    await expect(page.locator(".mermaid-wrapper svg")).toHaveCount(6, {
      timeout: 15_000,
    });
  });

  test("renders Mermaid diagrams inline under each section heading", async ({
    page,
  }) => {
    await page.goto("/architecture");

    const sections = [
      "System Overview",
      "Request Flow",
      "Authentication Flow",
      "Deployment Architecture",
      "Project Structure",
      "Data Flow: Chat Session",
    ];

    for (const section of sections) {
      const heading = page.getByRole("heading", {
        name: section,
        exact: true,
      });
      await expect(heading).toBeVisible();

      // Each section heading must be immediately followed by its own rendered diagram SVG
      const sectionDiagram = page.locator(
        `h2:has-text("${section}") + .mermaid-wrapper svg`,
      );
      await expect(sectionDiagram).toBeVisible({ timeout: 10_000 });
    }
  });

  test("does not display raw unrendered Mermaid syntax as plain text", async ({
    page,
  }) => {
    await page.goto("/architecture");

    // Ensure raw diagram source code is not left behind as unrendered text
    await expect(page.locator("pre.mermaid")).toHaveCount(0, {
      timeout: 15_000,
    });
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
