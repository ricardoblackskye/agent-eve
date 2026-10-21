import { describe, expect, it } from "vitest";
import { resolveOverviewError } from "../../app/dark-factory/ui/view-model";

/**
 * #427 — the overview page has INDEPENDENT panels: LLM cost budgets, LLM usage, customer usage and the call
 * policy all fetch from their OWN stores, not from run history. This function only ever sees the metrics and runs
 * sources, so it must never be allowed to decide that the page cannot be shown at all. It was: whenever the
 * run-history store was down it set `blocking`, `page.tsx` returned a full-page error for it, and every panel
 * below — including ones answering 200 with real data — was discarded.
 *
 * Two of these cases changed, and why:
 *  - "blocks the page only when there is no data to keep" pinned `blocking` as CORRECT. It was the defect, and
 *    pinning the wrong behaviour is exactly why the regression reached main and was reported from a running app.
 *  - "prefers the metrics error" silently dropped the runs error from the banner. Both stores can be down for
 *    unrelated reasons and are fixed in different places, so an operator needs to be told about both.
 */
describe("resolveOverviewError", () => {
  it("returns no error state when nothing failed", () => {
    expect(
      resolveOverviewError({
        metricsError: null,
        metricsHasData: true,
        runsError: null,
        runsHasData: true,
      }),
    ).toEqual({ banner: null, metricsUnavailable: false, runsUnavailable: false });
  });

  it("never blanks the board for a failed source, even with no data to keep (#427)", () => {
    const state = resolveOverviewError({
      metricsError: "Run history is unavailable",
      metricsHasData: false,
      runsError: null,
      runsHasData: false,
    });

    expect(state).toEqual({
      banner: "Run history is unavailable",
      metricsUnavailable: true,
      runsUnavailable: false,
    });
    // No blocking verdict may exist to act on: the page cannot know whether the OTHER stores are healthy.
    expect(Object.keys(state)).not.toContain("blocking");
  });

  it("marks a source unavailable only when it failed AND has no last-good data to keep", () => {
    expect(
      resolveOverviewError({
        metricsError: "Run history is unavailable",
        metricsHasData: true,
        runsError: null,
        runsHasData: false,
      }),
    ).toEqual({
      banner: "Run history is unavailable",
      metricsUnavailable: false,
      runsUnavailable: false,
    });
  });

  it("names EVERY failed source, so an operator knows which store to look at", () => {
    expect(
      resolveOverviewError({
        metricsError: "metrics down",
        metricsHasData: false,
        runsError: "runs down",
        runsHasData: true,
      }),
    ).toEqual({ banner: "metrics down · runs down", metricsUnavailable: true, runsUnavailable: false });
  });

  it("does not repeat one message that both sources report", () => {
    expect(
      resolveOverviewError({
        metricsError: "Run history is unavailable",
        metricsHasData: false,
        runsError: "Run history is unavailable",
        runsHasData: false,
      }).banner,
    ).toBe("Run history is unavailable");
  });
});