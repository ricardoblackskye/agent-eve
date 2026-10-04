// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useParams } = vi.hoisted(() => ({
  useParams: vi.fn(() => ({ runId: "df-1a2b" })),
}));
vi.mock("next/navigation", () => ({ useParams }));

import DarkFactoryRunDetailPage from "../../app/dark-factory/runs/[runId]/page";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const SUMMARY = {
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
};

const EVENTS = [
  {
    sequence: 1,
    event: {
      eventId: "evt-1",
      runId: "df-1a2b",
      type: "dispatch.started",
      stage: "dispatch",
      occurredAt: "2026-09-25T09:14:00.000Z",
    },
  },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      const url = String(input);
      if (url.includes("/api/dark-factory/control")) {
        return Promise.resolve(
          jsonResponse({
            available: true,
            factory: { paused: false, updatedAt: "2026-09-25T09:00:00.000Z" },
            events: [],
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({ summary: SUMMARY, events: EVENTS }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dark Factory run detail page", () => {
  it("renders the panel badges as PanelHead chips", async () => {
    const { container } = render(<DarkFactoryRunDetailPage />);
    await waitFor(() =>
      expect(container.querySelectorAll(".df-chip").length).toBeGreaterThan(0),
    );
    const chips = [...container.querySelectorAll(".df-chip")].map(
      (chip) => chip.textContent,
    );
    expect(chips).toContain("TERMINAL STOP");
    expect(chips).toContain("NO INFERRED ZEROS");
  });

  it("renders the run summary and event timeline", async () => {
    const { container } = render(<DarkFactoryRunDetailPage />);
    await waitFor(() =>
      expect(container.querySelectorAll(".df-event").length).toBeGreaterThan(0),
    );
    expect(container.textContent).toContain("owner/repo#198");
  });

  it("links back to the run list, before the directive chips", async () => {
    const { container } = render(<DarkFactoryRunDetailPage />);
    await waitFor(() =>
      expect(container.querySelectorAll(".df-chip").length).toBeGreaterThan(0),
    );
    const back = container.querySelector('a[href="/dark-factory/runs"]');
    expect(back?.textContent).toContain("Back to runs");
    const head = back?.closest(".df-panel-head");
    expect(head).toBeTruthy();
    const ordered = [...(head as Element).querySelectorAll("a, .df-chip")];
    expect(ordered[0]).toBe(back);
  });
});
