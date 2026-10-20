// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DarkFactoryLayout from "../../app/dark-factory/layout";

describe("Dark Factory rail navigation", () => {
  it("labels the rail links Overview and Runs (not bare letters)", () => {
    render(
      <DarkFactoryLayout>
        <div>panel body</div>
      </DarkFactoryLayout>,
    );
    const overview = screen.getByText("Overview");
    const runs = screen.getByText("Runs");
    expect(overview.closest("a")?.getAttribute("href")).toBe("/dark-factory");
    expect(runs.closest("a")?.getAttribute("href")).toBe("/dark-factory/runs");
  });

  /**
   * #414 (epic #403 R2) — the repo list page shipped with no way to reach it from the board, so it was reachable
   * only by typing the URL. The link sits directly UNDER Runs, and the ORDER assertion is the point: a link that
   * exists but drifts above Runs is the same miss wearing a different hat.
   */
  it("links to the repositories page directly under Runs", () => {
    const { container } = render(
      <DarkFactoryLayout>
        <div>panel body</div>
      </DarkFactoryLayout>,
    );
    const destinations = [...container.querySelectorAll(".df-rail-link")].map((node) =>
      node.getAttribute("href"),
    );
    expect(destinations).toEqual([
      "/dark-factory",
      "/dark-factory/runs",
      "/dark-factory/repos",
    ]);
    expect(screen.getByText("Repositories").closest("a")?.getAttribute("href")).toBe(
      "/dark-factory/repos",
    );
  });
});
