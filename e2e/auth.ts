import type { Page } from "@playwright/test";

/**
 * Dev-mode sign-in so the gated pages (`/`, `/architecture`, `/releasenotes`)
 * can be exercised without real Google credentials.
 *
 * Requires `AUTH_DEV_MODE=1` (set in the Playwright CI job and by anyone
 * running `npm run test:e2e` locally). The endpoint is fail-closed: it 404s
 * when NODE_ENV=production.
 */
export async function signInAsAllowed(page: Page): Promise<void> {
  await page.request.get("/api/auth/dev?email=cuillinguy@gmail.com&next=/");
}
