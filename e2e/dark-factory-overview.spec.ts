import { expect, test } from "@playwright/test";
import { signInAsAllowed } from "./auth";

/**
 * Dark Factory overview styling (#258).
 *
 * Asserts the RENDERED result, not just the markup. Each of the four reported
 * defects had a cause that markup alone cannot catch — the usage tables had no
 * CSS rule at all, the recent list was not a table, and the trend was a row of
 * flex bars that filled the width whenever the window held one or two dates.
 */
test.describe("Dark Factory overview styling", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAllowed(page);
  });

  test("the usage table is styled, not bare", async ({ page }) => {
    await page.goto("/dark-factory");
    const table = page.locator("table.df-usage-table").first();
    // Documentation: names the empty state at the point of use. The locator assertions above are
    // what actually fail when the store is empty — proven by re-running this file against an empty
    // DF_USAGE_DB_PATH, where both tests fail with "element(s) not found".
    await expect(table).toBeVisible();

    // The bug was "no styles at all", so assert the computed properties that
    // prove the rule now applies — padding, right-aligned numerals, uppercase head.
    // A VALUE cell — not the first column, which is the label column and is
    // left-aligned so it lines up with its own heading.
    const cell = table.locator("tbody td").nth(1);
    const style = await cell.evaluate((node) => {
      const computed = getComputedStyle(node);
      return {
        paddingTop: computed.paddingTop,
        paddingLeft: computed.paddingLeft,
        textAlign: computed.textAlign,
      };
    });
    expect(style.paddingTop).toBe("8px");
    expect(style.paddingLeft).toBe("10px");
    expect(style.textAlign).toBe("right");
    await expect(table.locator("thead th").first()).toHaveCSS(
      "text-transform",
      "uppercase",
    );

    // Every heading must sit over its OWN values. The reported bug was a
    // left-aligned heading above right-aligned numbers, so assert the pairing
    // column by column rather than trusting the rule.
    const columns = await table.evaluate((node) => {
      const heads = [...node.querySelectorAll("thead th")];
      const row = node.querySelector("tbody tr");
      const cells = row ? [...row.children] : [];
      return heads.map((th, index) => ({
        head: getComputedStyle(th).textAlign,
        cell: cells[index] ? getComputedStyle(cells[index]).textAlign : null,
      }));
    });
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      if (column.cell === null) continue;
      expect(column.head).toBe(column.cell);
    }

    // A captioned table must not clip its own caption. `overflow: hidden` on the
    // table box cut the top off "Totals" / "By model" / "By day" / "By run",
    // because a `<caption>` sits outside the table's box.
    await expect(table.locator("caption").first()).toBeVisible();
    expect(
      await table.evaluate((node) => getComputedStyle(node).overflow),
    ).toBe("visible");
  });

  test("recent executions is a table with a header per column", async ({
    page,
  }) => {
    await page.goto("/dark-factory");
    const table = page.locator("table.df-recent-table");
    await expect(table).toBeVisible();
    await expect(table.locator("thead th")).toHaveText([
      "Run",
      "Issue",
      "Repository",
      "Stage",
      "Updated",
      "Status",
      "Elapsed",
      "Cost",
    ]);
  });

  test("the outcome trend renders as a chart, not a solid block", async ({
    page,
  }) => {
    await page.goto("/dark-factory");
    const chart = page.locator("svg.df-trend-chart");
    await expect(chart).toBeVisible();

    const box = await chart.boundingBox();
    expect(box).not.toBeNull();
    // A chart occupies a bounded band; the old bar stretched the full width.
    expect(box?.height ?? 0).toBeGreaterThan(20);
    expect(box?.width ?? 0).toBeGreaterThan(100);
    expect(
      await chart.locator("circle.df-trend-point").count(),
    ).toBeGreaterThan(0);
  });

  test("the overview page does not overflow horizontally when narrow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/dark-factory");
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

/**
 * #278 T3 — the cost panels added by #277/#339 asserted in the BROWSER.
 *
 * The unit tests (#339) prove the absent-not-zero rule in isolation; this proves the panels actually
 * render data on a real page. Only stores the browser-test job configures are used here — the usage and
 * tenant stores — because the cost-budget driver is deliberately absent from that job (arming it
 * without caps refuses every model call, ADR 0015).
 *
 * Anti-vacuity is PROVEN here, not assumed. Against the seeded usage store this file passes;
 * pointed at an EMPTY usage store these two tests FAIL on the chart and table locators, because an
 * empty store makes the panel render its empty state and nothing matches. The LOCATORS are therefore
 * the load-bearing assertions.
 *
 * The `Nothing measured for this window` check at the end of each test is DOCUMENTATION rather than the
 * guard: it names the empty state at the point of use. It does not fire in practice, because the
 * locator above it fails first whenever the data is absent.
 */
test.describe("#278 the cost panels render data, not empty states", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAllowed(page);
  });

  test("the daily cost and cost-by-model charts render as charts", async ({
    page,
  }) => {
    await page.goto("/dark-factory");

    const daily = page.locator('svg[aria-label="Daily cost"]');
    await expect(daily).toBeVisible();
    expect(await daily.locator("circle").count()).toBeGreaterThan(0);

    const byModel = page.locator('svg[aria-label="Cost by model"]');
    await expect(byModel).toBeVisible();
    expect(await byModel.locator("rect").count()).toBeGreaterThan(0);

    await expect(
      page.getByText("Nothing measured for this window"),
    ).toHaveCount(0);
  });

  test("the by-task-type breakdown renders rows", async ({ page }) => {
    await page.goto("/dark-factory");

    const table = page.locator("table", {
      has: page.locator("caption", { hasText: "By task type" }),
    });
    // Documentation: names the empty state at the point of use. The locator assertions above are
    // what actually fail when the store is empty — proven by re-running this file against an empty
    // DF_USAGE_DB_PATH, where both tests fail with "element(s) not found".
    await expect(table).toBeVisible();
    expect(await table.locator("tbody tr").count()).toBeGreaterThan(0);

    await expect(
      page.getByText("Nothing measured for this window"),
    ).toHaveCount(0);
  });
});
