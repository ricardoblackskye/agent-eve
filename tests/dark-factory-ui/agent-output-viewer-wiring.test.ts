// @vitest-environment jsdom
/**
 * #561 — the run detail page must RENDER the agent output panel.
 *
 * The page is a client component that fetches and holds state, so it cannot be unit-rendered as
 * cheaply as the panels are. The panel's own behaviour is proven in agent-output-panel.test.tsx;
 * what this file pins is the WIRING, which is precisely what rots silently when a panel exists but
 * nothing renders it. The middle case is the control: it asserts a panel the page already renders,
 * so the guard proves it is looking at the real page rather than an empty string.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PAGE = readFileSync(
  resolve(process.cwd(), "app/dark-factory/runs/[runId]/page.tsx"),
  "utf8",
);

describe("the run detail page renders the agent output panel (#561)", () => {
  it("imports the panel", () => {
    expect(PAGE).toContain("AgentOutputPanel");
  });

  it("CONTROL: still renders a panel it already had", () => {
    expect(PAGE).toContain("RunDiffPanel");
  });

  it("renders it with the run's events", () => {
    const idx = PAGE.indexOf("<AgentOutputPanel");
    expect(idx).toBeGreaterThan(-1);
    expect(PAGE.slice(idx, idx + 240)).toMatch(/events=/);
  });
});
