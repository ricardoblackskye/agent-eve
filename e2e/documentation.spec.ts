import { expect, test } from "@playwright/test";
import { signInAsAllowed } from "./auth";

/**
 * Documentation pages (#234).
 *
 * Deliberately NOT a fixed diagram count. The previous spec pinned
 * `.mermaid-wrapper svg` to exactly 6 on a single page, so any content change
 * became a false failure — and the per-section assertion
 * (`h2:has-text("…") + .mermaid-wrapper svg`) could not survive the split at all.
 * These assert the property that matters: diagrams render, and no raw syntax is
 * left behind.
 */
const PAGES = [
  "overview",
  "flows",
  "deployment",
  "configuration",
  "platform-adapters",
  "dark-factory",
  "dark-factory-operations",
];

/** Pages that carried Mermaid diagrams when ARCHITECTURE.md was split. */
const PAGES_WITH_DIAGRAMS = ["overview", "flows", "deployment"];

test.describe("Documentation", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAllowed(page);
  });

  test("index links to every page", async ({ page }) => {
    await page.goto("/documentation");

    await expect(
      page.getByRole("heading", { name: "Documentation", exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    for (const slug of PAGES) {
      await expect(
        page.locator(`a[href="/documentation/${slug}"]`),
        `${slug} should be linked from the index`,
      ).toHaveCount(1);
    }
  });

  test("every page renders its markdown with a title", async ({ page }) => {
    for (const slug of PAGES) {
      await page.goto(`/documentation/${slug}`);
      await expect(
        page.locator(".architecture-container h1").first(),
        `${slug} should render an h1`,
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test("renders Mermaid diagrams and leaves no raw syntax", async ({ page }) => {
    for (const slug of PAGES_WITH_DIAGRAMS) {
      await page.goto(`/documentation/${slug}`);

      await expect(
        page.locator(".mermaid-wrapper svg").first(),
        `${slug} should render at least one diagram`,
      ).toBeVisible({ timeout: 15_000 });

      // Raw diagram source must not be left behind as unrendered text.
      await expect(page.locator("pre.mermaid")).toHaveCount(0, {
        timeout: 15_000,
      });
    }
  });

  test("the Dark Factory page carries its subsections", async ({ page }) => {
    await page.goto("/documentation/dark-factory");

    for (const section of [
      "Execution memory",
      "Dispatch / self-correction",
      "Observability",
      "Worker environment",
      "circuit breaker",
    ]) {
      await expect(
        page.getByRole("heading", { name: new RegExp(section, "i") }).first(),
        `${section} heading should be present`,
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test("content previously on /architecture is still served", async ({ page }) => {
    await page.goto("/documentation/overview");

    for (const text of [/Vercel/i, /Next\.js/i, /Eve/i]) {
      await expect(page.getByText(text).first()).toBeVisible();
    }
  });
});