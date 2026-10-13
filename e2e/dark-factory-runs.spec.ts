import { expect, test } from "@playwright/test";
import { signInAsAllowed } from "./auth";

/**
 * #278 T1 — the runs ledger and the run detail view were covered by nothing.
 *
 * Both read the run-history store, which the browser-test job DOES configure, so both are assertable
 * here. Control ACTIONS are deliberately NOT driven through the browser: that job omits
 * DF_CONTROL_DRIVER (arming the control/budget stores without caps refuses model calls — ADR 0015),
 * so a control action is asserted at the API level instead.
 *
 * The fixture MUST supply rows. An empty store renders the panel's empty state, and an assertion
 * against empty markup would pass while proving nothing — see the anti-vacuity check in T5.
 */
test.describe("runs ledger (#278)", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAllowed(page);
  });

  test("lists seeded runs rather than an auth or empty state", async ({
    page,
  }) => {
    await page.goto("/dark-factory/runs");

    await expect(page.locator("h1")).toHaveText("Execution ledger");

    const table = page.locator("table").first();
    await expect(table).toBeVisible();

    const rows = table.locator("tbody tr");
    expect(await rows.count()).toBeGreaterThan(0);

    await expect(page.getByText(/sign in required/i)).toHaveCount(0);
  });

  test("a run's detail view shows its evidence, reached from the ledger", async ({
    page,
  }) => {
    await page.goto("/dark-factory/runs");

    const runLink = page.locator("table tbody tr a").first();
    await expect(runLink).toBeVisible();
    const href = await runLink.getAttribute("href");
    expect(href, "a ledger row should link to its run detail").toBeTruthy();

    await page.goto(href as string);

    await expect(page.locator(".df-detail-grid")).toBeVisible();
    await expect(page.getByText(/sign in required/i)).toHaveCount(0);
  });

  /**
   * T5 anti-vacuity, without a second server: Next allows only one dev server per directory, so
   * instead of re-running against an empty store we FORCE the empty condition through the UI, using
   * the ledger's own filter and an unknown run id. Each assertion below proves the one above it can
   * fail — otherwise "rows > 0" and "the grid is visible" would be true of empty markup too.
   */
  test("anti-vacuity: a search that matches nothing empties the ledger", async ({
    page,
  }) => {
    await page.goto("/dark-factory/runs");

    const rows = page.locator("table").first().locator("tbody tr");
    // The ledger POLLS: wait for rows rather than sampling once, or this races the fetch.
    await expect
      .poll(async () => rows.count(), { timeout: 15_000 })
      .toBeGreaterThan(0);

    await page.locator(".df-filters input").first().fill("zzz-no-such-run-zzz");

    await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBe(0);
  });

  test("anti-vacuity: an unknown run id does not render the detail grid", async ({
    page,
  }) => {
    await page.goto("/dark-factory/runs/does-not-exist-999");

    await expect(page.locator(".df-detail-grid")).toHaveCount(0);
  });
});
