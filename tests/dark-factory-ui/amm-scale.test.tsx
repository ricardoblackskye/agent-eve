// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AmmScale } from "../../app/dark-factory/ui/amm-scale";
import {
  agentEveScan,
  type AmmReadinessProvider,
} from "../../agent/lib/dark-factory/amm-readiness";

/**
 * #415 (epic #403 R3) — the AMM readiness scale.
 *
 * The load-bearing test is the second one: a scan whose metric set DIFFERS from this repository's renders correctly.
 * That is what proves the component holds no metric names of its own, since the catalogue arrives with the scan - and
 * it is the same rule the whitepaper's signals impose, because a component that knows the eight pillars would need
 * editing the day the scanner reports a ninth.
 */
function minimalScan(pillars: Array<{ id: number; name: string; level: number }>) {
  return {
    repo: "owner/example",
    scannedAt: "2026-10-20T00:00:00.000Z",
    overall: { points: 40, maxPoints: 100, level: 3, label: "Level 3 (Standardized)" },
    pillars: pillars.map((pillar) => ({
      ...pillar,
      label: `Level ${pillar.level}`,
      benchmark: `${pillar.name} benchmark`,
      evidence: [`evidence/${pillar.id}`],
      signals: [{ id: `s-${pillar.id}`, label: `${pillar.name} signal`, present: true, level: pillar.level }],
    })),
    capabilities: [],
  };
}

describe("#415 the AMM scale", () => {
  it("leads with the overall level and the points against the maximum", () => {
    render(<AmmScale repo="ricardoblackskye/agent-eve" scan={agentEveScan()} />);

    expect(screen.getByText(/level 4 \(optimized\)/i)).toBeTruthy();
    expect(screen.getByText(/74/)).toBeTruthy();
    expect(screen.getByText(/100/)).toBeTruthy();
  });

  it("renders a metric set that DIFFERS from this repository's, proving nothing is hard-coded", () => {
    render(
      <AmmScale
        repo="owner/example"
        scan={minimalScan([
          { id: 1, name: "Made-up pillar one", level: 2 },
          { id: 2, name: "Made-up pillar two", level: 5 },
        ])}
      />,
    );

    expect(screen.getByText("Made-up pillar one")).toBeTruthy();
    expect(screen.getByText("Made-up pillar two")).toBeTruthy();
    // And none of this repository's own pillars leak in from a constant.
    expect(screen.queryByText(/Style & Validation/)).toBeNull();
  });

  it("shows the production floor, because clearing it is the model's own pass mark", () => {
    render(<AmmScale repo="ricardoblackskye/agent-eve" scan={agentEveScan()} />);
    expect(screen.getByText(/level 3/i)).toBeTruthy();
  });

  it("marks each signal present or absent, so a missing check is visible rather than merely not mentioned", () => {
    const scan = minimalScan([{ id: 1, name: "Pillar", level: 3 }]);
    scan.pillars[0].signals = [
      { id: "linter", label: "Linter enforced", present: true, level: 1 },
      { id: "pre-commit", label: "Pre-commit hooks", present: false, level: 2 },
    ];
    const { container } = render(<AmmScale repo="owner/example" scan={scan} />);

    const signal = (id: string) => container.querySelector(`[data-signal="${id}"]`);
    expect(signal("linter")?.getAttribute("data-present")).toBe("yes");
    expect(signal("pre-commit")?.getAttribute("data-present")).toBe("no");
    expect(screen.getByText("Pre-commit hooks")).toBeTruthy();
  });

  it("says a repository has not been scanned rather than rendering an empty scale", () => {
    render(<AmmScale repo="owner/example" scan={undefined} />);
    expect(screen.getByText(/no readiness scan yet/i)).toBeTruthy();
    expect(screen.getByText(/owner\/example/)).toBeTruthy();
  });
});

/**
 * #415 task 4 — a GUARD, not a RED: the component already renders whatever a scan contains, so this passes by design.
 * It holds the SEAM rather than the rendering: a database adapter satisfies the same interface as the fixture, so
 * swapping them is wiring. Whoever builds the scanner should be able to replace the fixture and leave this file alone.
 */
describe("#415 the provider seam", () => {
  it("renders a scan produced by a different adapter, with no component change", async () => {
    const databaseAdapter: AmmReadinessProvider = {
      async scan(repo: string) {
        return repo === "owner/example"
          ? minimalScan([{ id: 1, name: "Metric from the database", level: 4 }])
          : undefined;
      },
    };

    const scan = await databaseAdapter.scan("owner/example");
    render(<AmmScale repo="owner/example" scan={scan} />);

    expect(screen.getByText("Metric from the database")).toBeTruthy();
  });
});
