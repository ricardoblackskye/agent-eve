import { describe, expect, it } from "vitest";
import { resolveOverviewError } from "../../app/dark-factory/ui/view-model";

describe("resolveOverviewError", () => {
  it("returns no error state when nothing failed", () => {
    expect(
      resolveOverviewError({
        metricsError: null,
        metricsHasData: true,
        runsError: null,
        runsHasData: true,
      }),
    ).toEqual({ blocking: null, banner: null });
  });

  it("blocks the page only when there is no data to keep", () => {
    expect(
      resolveOverviewError({
        metricsError: "Request failed with status 503",
        metricsHasData: false,
        runsError: null,
        runsHasData: false,
      }),
    ).toEqual({ blocking: "Request failed with status 503", banner: null });
  });

  it("keeps the board with a banner once data exists", () => {
    expect(
      resolveOverviewError({
        metricsError: "Request failed with status 503",
        metricsHasData: true,
        runsError: null,
        runsHasData: true,
      }),
    ).toEqual({ blocking: null, banner: "Request failed with status 503" });
  });

  it("prefers the metrics error and still banners when runs has data", () => {
    expect(
      resolveOverviewError({
        metricsError: "metrics down",
        metricsHasData: false,
        runsError: "runs down",
        runsHasData: true,
      }),
    ).toEqual({ blocking: null, banner: "metrics down" });
  });
});