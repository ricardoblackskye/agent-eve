// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RepoList } from "../../app/dark-factory/ui/repo-list";

const READINESS = { atOrAboveFloor: 1, active: 2, pct: 50 };

describe("RepoList", () => {
  it("renders a row per repo, with its AMM level and a link to the detail page", () => {
    render(
      <RepoList
        readiness={READINESS}
        rows={[
          { repo: "ricardoblackskye/agent-eve", level: 4, label: "Level 4 (Optimized)" },
          { repo: "ricardoblackskye/WebFeedPOC", level: 3, label: "Level 3 (Standardized)" },
        ]}
      />,
    );
    const row = screen.getByText("ricardoblackskye/agent-eve");
    expect(row.closest("a")?.getAttribute("href")).toBe(
      "/dark-factory/repos/ricardoblackskye/agent-eve",
    );
    expect(screen.getByText("Level 4 (Optimized)")).toBeTruthy();
    expect(screen.getByText("ricardoblackskye/WebFeedPOC")).toBeTruthy();
  });

  it("leads with the share of active repos that are agent-ready", () => {
    render(<RepoList readiness={READINESS} rows={[]} />);
    expect(screen.getByText(/50%/)).toBeTruthy();
    expect(screen.getByText(/of 2 active repos/i)).toBeTruthy();
  });

  it("says WHY it is empty, so an empty page does not read as a bug", () => {
    render(<RepoList readiness={{ atOrAboveFloor: 0, active: 0, pct: 0 }} rows={[]} />);
    expect(screen.getByText(/no configured repository has a readiness scan yet/i)).toBeTruthy();
  });
});
