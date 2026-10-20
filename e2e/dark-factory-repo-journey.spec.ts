import { expect, test } from "@playwright/test";

/**
 * #421 (R2 follow-up) — the list -> detail -> runs journey.
 *
 * All three pages were unit-tested and nothing exercised the click-through, which is exactly how a wrong href, or a
 * param name that disagrees with what the route reads, passes every test in the suite while being broken in a
 * browser. R2's Validation named this and it was never done.
 *
 * The load-bearing assertion is the REQUEST the detail page makes. Its URL must name the repository the list sent us
 * to, so a href/param mismatch fails here as "asked for the wrong repo" rather than as a page that merely looks
 * empty - which is the failure mode that survives a rendering-only assertion.
 */
test.describe("repository journey (#421)", () => {
  test.beforeEach(async ({ page }) => {
    // Sign in through the dev-only door, then PROVE it granted a session. Without this check a missing session
    // surfaces as "element(s) not found" on a page that quietly redirected to Google - naming the symptom instead of
    // the cause. 404 means AUTH_DEV_MODE is off for the server; 302 means a session cookie was issued.
    const signIn = await page.request.get(
      "/api/auth/dev?email=cuillinguy@gmail.com&next=/dark-factory/repos",
      { maxRedirects: 0 },
    );
    expect(
      signIn.status(),
      `dev sign-in did not grant a session (status ${signIn.status()})`,
    ).toBe(302);
  });

  test("opens a repository from the list and loads that repository's runs", async ({
    page,
  }) => {
    await page.goto("/dark-factory/repos");

    const panel = page.locator('section[aria-label="Repositories"]');
    await expect(panel).toBeVisible();

    const repoLink = panel.locator("table.df-table tbody tr a").first();
    await expect(
      repoLink,
      "the list should offer a repository to open",
    ).toBeVisible();

    const href = await repoLink.getAttribute("href");
    expect(href, "a repository row must link to its detail page").toBeTruthy();
    const repo = (href as string).replace("/dark-factory/repos/", "");
    expect(repo, "the href should name an owner/name repository").toMatch(
      /^[^/]+\/[^/]+$/,
    );

    // Watch the API while the page loads, rather than sampling the DOM afterwards.
    const runsResponse = page.waitForResponse((response) =>
      response.url().includes("/api/dark-factory/runs"),
    );
    await page.goto(href as string);

    await expect(page.locator("h1")).toContainText(repo);

    const response = await runsResponse;
    expect(response.ok(), "the runs API should answer the detail page").toBe(
      true,
    );
    const requested = new URL(response.url());
    expect(
      requested.searchParams.get("repo"),
      "the detail page must ask the API for the repository the list sent us to",
    ).toBe(repo);
    expect(requested.searchParams.get("sort")).toBe("createdAt");

    // ...and the journey ends on a panel a human can read.
    await expect(page.locator("section.df-panel").first()).toBeVisible();
  });

  /**
   * Anti-vacuity, in the spirit of the ledger spec's T5: proves the assertion above can FAIL, without a second
   * server. If the repo param were hard-coded or dropped, the request would still be made - and this test would
   * still pass while the first one lied. So assert the param is DERIVED from the route.
   */
  test("anti-vacuity: the runs request follows the repository named in the URL", async ({
    page,
  }) => {
    const runsResponse = page.waitForResponse((response) =>
      response.url().includes("/api/dark-factory/runs"),
    );
    await page.goto("/dark-factory/repos/zzz-owner/zzz-repo");

    const requested = new URL((await runsResponse).url());
    expect(requested.searchParams.get("repo")).toBe("zzz-owner/zzz-repo");
  });
});
