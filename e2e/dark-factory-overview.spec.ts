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
    await expect(table).toBeVisible();

    // The bug was "no styles at all", so assert the computed properties that
    // prove the rule now applies — padding, right-aligned numerals, uppercase head.
    const cell = table.locator("tbody td").first();
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
    expect(await table.evaluate((node) => getComputedStyle(node).overflow)).toBe(
      "visible",
    );
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
