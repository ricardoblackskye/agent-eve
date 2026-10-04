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
});
