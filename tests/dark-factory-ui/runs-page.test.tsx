// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import DarkFactoryRunsPage from "../../app/dark-factory/runs/page";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const RUNS = [
  {
    runId: "df-1a2b",
    repo: "owner/repo",
    issue: 198,
    status: "succeeded" as const,
    stage: "terminal",
    createdAt: "2026-09-25T09:14:00.000Z",
    updatedAt: "2026-09-25T09:28:02.000Z",
    startedAt: "2026-09-25T09:14:00.000Z",
    completedAt: "2026-09-25T09:28:02.000Z",
    attemptCount: 3,
    reviewCount: 2,
    iterationCount: 3,
    fixCycleCount: 1,
    latencyMs: 1917,
    costUsd: 0.42,
    prUrl: "https://github.com/owner/repo/pull/202",
  },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(jsonResponse({ runs: RUNS })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe("Dark Factory runs page", () => {
  it("navigates to the run detail page when a row is clicked", async () => {
    const { container } = render(<DarkFactoryRunsPage />);
    await waitFor(() =>
      expect(container.querySelectorAll(".df-table-row")).toHaveLength(1),
    );
    fireEvent.click(container.querySelector(".df-table-row") as Element);
    expect(push).toHaveBeenCalledWith("/dark-factory/runs/df-1a2b");
  });

  it("links each run id to its detail route", async () => {
    const { container } = render(<DarkFactoryRunsPage />);
    await waitFor(() =>
      expect(container.querySelectorAll(".df-table-row")).toHaveLength(1),
    );
    expect(
      container.querySelector('a[href="/dark-factory/runs/df-1a2b"]'),
    ).toBeTruthy();
  });

  it("no longer renders the inline selected-run preview", async () => {
    const { container } = render(<DarkFactoryRunsPage />);
    await waitFor(() =>
      expect(container.querySelectorAll(".df-table-row")).toHaveLength(1),
    );
    expect(container.textContent).not.toContain("SELECTED RUN");
  });
});
