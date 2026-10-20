// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ReposPage from "../../app/dark-factory/repos/page";

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * #413 (epic #403 R1) — the page, not just the rule.
 *
 * The page reads the runner's allowed-repo setting through the SAME resolver the worker uses, so these tests drive it
 * from the environment rather than from an injected list: that is the property worth proving, since a page with its
 * own copy of the config would silently disagree with the worker.
 */
describe("Dark Factory repos page", () => {
  it("lists the configured repo that has been scanned", async () => {
    vi.stubEnv(
      "DF_WORKER_ALLOWED_REPOS",
      "ricardoblackskye/agent-eve,ricardoblackskye/WebFeedPOC",
    );
    render(await ReposPage());

    const link = screen.getByText("ricardoblackskye/agent-eve");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "/dark-factory/repos/ricardoblackskye/agent-eve",
    );
    // Configured, but no scan yet, so it is not listed.
    expect(screen.queryByText("ricardoblackskye/WebFeedPOC")).toBeNull();
    expect(screen.getByText(/agent-ready/i)).toBeTruthy();
  });

  it("says why the list is empty when nothing has been scanned", async () => {
    vi.stubEnv("DF_WORKER_ALLOWED_REPOS", "ricardoblackskye/WebFeedPOC");
    render(await ReposPage());
    expect(
      screen.getByText(/no configured repository has a readiness scan yet/i),
    ).toBeTruthy();
  });
});
