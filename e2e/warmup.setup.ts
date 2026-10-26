import { expect, test as setup } from "@playwright/test";
import { signInAsAllowed } from "./auth";
import { warmRoutes } from "../tests/support/warm-routes";

/**
 * #473 — pay `next dev`'s compile cost HERE, once, before any assertion runs.
 *
 * On a cold tree Next compiles each route on first touch: 25-37s measured, against an expect
 * timeout of 15s. The assertions then die before any product behaviour is exercised, and four
 * specs report what look like product regressions.
 *
 * This is a setup PROJECT rather than `globalSetup` or a per-file `beforeAll` on purpose:
 *
 * - a setup project is ordered after `webServer` is ready and before every dependent project,
 *   which `globalSetup` does not guarantee;
 * - it runs ONCE for the whole run, so `fullyParallel` cannot re-race the compiler per worker;
 * - the retry and "a 404 still proves compilation" rules stay in the unit-tested module rather
 *   than being re-derived inside a spec.
 *
 * It does NOT relax a single assertion. The specs keep their 15s expect timeout; the compiler is
 * simply no longer on their critical path. Raising timeouts was rejected in the issue for the
 * right reason: it hides the signal and slows every run, CI included.
 */

const LIST_API = "/api/dark-factory/runs?limit=50";
const LEDGER = "/dark-factory/runs";
const UNKNOWN_RUN = "/dark-factory/runs/does-not-exist-999";

/** Cold compile is 25-37s per route and several are warmed, so this needs real headroom. */
const WARMUP_TIMEOUT_MS = 300_000;

setup("warm the dev-mode routes the runs specs touch", async ({ page }) => {
  setup.setTimeout(WARMUP_TIMEOUT_MS);

  await signInAsAllowed(page);

  const targets = [LIST_API, LEDGER, UNKNOWN_RUN];

  // A real run id compiles the detail page. The list may legitimately be empty in an
  // environment without the seeded fixture, and that is not a warm-up failure: UNKNOWN_RUN
  // already compiles the same dynamic route.
  try {
    const response = await page.request.get(LIST_API);
    if (response.ok()) {
      const payload: unknown = await response.json();
      const runs: unknown[] = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { runs?: unknown[] })?.runs)
          ? ((payload as { runs: unknown[] }).runs as unknown[])
          : [];
      // The summary field is `runId`; `id` is accepted only as a fallback so a future rename
      // degrades to the unknown-run route instead of silently warming nothing.
      const first = runs[0] as { runId?: unknown; id?: unknown } | undefined;
      const runId = first?.runId ?? first?.id;
      if (typeof runId === "string" && runId.length > 0) {
        targets.push(`/dark-factory/runs/${runId}`);
      } else {
        console.log(
          "[warmup] no run id discovered; the unknown-run route still compiles the detail page",
        );
      }
    }
  } catch {
    // Unreadable list: fall through with the routes already collected.
  }

  const report = await warmRoutes(targets, async (path) =>
    (await page.request.get(path)).status(),
  );

  // Printed so a slow-but-successful warm-up is visible in the CI log rather than silent.
  console.log(
    `[warmup] ${report.warmed.length} route(s): ` +
      report.warmed.map((r) => `${r.path} -> ${r.status}`).join(", "),
  );

  expect(
    report.warmed.length,
    "every warm-up target should have answered below 500",
  ).toBeGreaterThan(0);
});
