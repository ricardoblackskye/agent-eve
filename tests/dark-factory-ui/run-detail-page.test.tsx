// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  gitDiff: "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
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

  it("renders the run detail metric tiles from the summary", async () => {
    const { container } = render(<DarkFactoryRunDetailPage />);
    await waitFor(() => expect(container.textContent).toContain("Iterations"));
    const text = container.textContent ?? "";
    expect(text).toContain("Started");
    expect(text).toContain("Elapsed");
    expect(text).toContain("Attempts");
    expect(text).toContain("Review round");
    expect(text).toContain("Measured cost");
    expect(text).toContain("Iterations");
    expect(text).toContain("Fix cycles");
  });

  it("wires Resume run and Stop run to the control API", async () => {
    const fetch = vi.fn((input: unknown) => {
      const url = String(input);
      if (url.includes("/api/dark-factory/control")) {
        return Promise.resolve(
          jsonResponse({
            available: true,
            factory: { paused: true, updatedAt: "2026-09-25T09:00:00.000Z" },
            run: {
              paused: true,
              stopped: false,
              updatedAt: "2026-09-25T09:00:00.000Z",
            },
            events: [],
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          summary: { ...SUMMARY, status: "running" as const },
          events: EVENTS,
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const { container } = render(<DarkFactoryRunDetailPage />);
    await waitFor(() =>
      expect(
        container.querySelector('[aria-label="Run controls"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Resume run" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop run" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume run" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/dark-factory/control",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"action":"resume"'),
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/dark-factory/control",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"action":"stop"'),
        }),
      ),
    );
  });

  it("for a failed run, shows Resume run only (no Pause run, no Stop run)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url.includes("/api/dark-factory/control")) {
          return Promise.resolve(
            jsonResponse({
              available: true,
              factory: { paused: false, updatedAt: "2026-09-25T09:00:00.000Z" },
              run: {
                paused: false,
                stopped: false,
                updatedAt: "2026-09-25T09:00:00.000Z",
              },
              events: [],
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            summary: { ...SUMMARY, status: "failed" as const },
            events: EVENTS,
          }),
        );
      }),
    );
    const { container } = render(<DarkFactoryRunDetailPage />);
    await waitFor(() =>
      expect(
        container.querySelector('[aria-label="Run controls"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Resume run" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause run" })).toBeNull();
  });

  it("for a running run, shows Pause run and Stop run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url.includes("/api/dark-factory/control")) {
          return Promise.resolve(
            jsonResponse({
              available: true,
              factory: { paused: false, updatedAt: "2026-09-25T09:00:00.000Z" },
              run: {
                paused: false,
                stopped: false,
                updatedAt: "2026-09-25T09:00:00.000Z",
              },
              events: [],
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            summary: { ...SUMMARY, status: "running" as const },
            events: EVENTS,
          }),
        );
      }),
    );
    const { container } = render(<DarkFactoryRunDetailPage />);
    await waitFor(() =>
      expect(
        container.querySelector('[aria-label="Run controls"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Pause run" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop run" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume run" })).toBeNull();
  });

  it("for a succeeded run, shows neither Resume nor Stop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url.includes("/api/dark-factory/control")) {
          return Promise.resolve(
            jsonResponse({
              available: true,
              factory: { paused: false, updatedAt: "2026-09-25T09:00:00.000Z" },
              run: {
                paused: false,
                stopped: false,
                updatedAt: "2026-09-25T09:00:00.000Z",
              },
              events: [],
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            summary: { ...SUMMARY, status: "succeeded" as const },
            events: EVENTS,
          }),
        );
      }),
    );
    const { container } = render(<DarkFactoryRunDetailPage />);
    await waitFor(() =>
      expect(
        container.querySelector('[aria-label="Run controls"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Resume run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause run" })).toBeNull();
  });

  it("for a stopped run, shows neither Resume nor Stop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url.includes("/api/dark-factory/control")) {
          return Promise.resolve(
            jsonResponse({
              available: true,
              factory: { paused: false, updatedAt: "2026-09-25T09:00:00.000Z" },
              run: {
                paused: false,
                stopped: true,
                updatedAt: "2026-09-25T09:00:00.000Z",
              },
              events: [],
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            summary: { ...SUMMARY, status: "running" as const },
            events: EVENTS,
          }),
        );
      }),
    );
    const { container } = render(<DarkFactoryRunDetailPage />);
    await waitFor(() =>
      expect(
        container.querySelector('[aria-label="Run controls"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Resume run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause run" })).toBeNull();
  });

  it("renders the OUTCOME artifact panel linking the PR", async () => {
    const { container } = render(<DarkFactoryRunDetailPage />);
    await waitFor(() =>
      expect(container.querySelector("a.df-outcome-link")).not.toBeNull(),
    );
    expect(
      container.querySelector("a.df-outcome-link")?.getAttribute("href"),
    ).toBe("https://github.com/owner/repo/pull/202");
  });

  it("renders the captured run diff panel", async () => {
    const { container } = render(<DarkFactoryRunDetailPage />);
    await waitFor(() =>
      expect(container.querySelector(".df-diff")).not.toBeNull(),
    );
    expect(container.textContent).toContain("const a = 2;");
  });

  it("renders captured tester test output from a review-round event", async () => {
    const testResults = [
      { testFile: "src/foo.test.ts", testCaseName: "adds numbers", passed: true },
      { testFile: "src/bar.test.ts", testCaseName: "throws on null", passed: false },
    ];
    const events = [
      ...EVENTS,
      {
        sequence: 2,
        event: {
          eventId: "evt-review",
          runId: "df-1a2b",
          type: "review.round",
          stage: "review",
          occurredAt: "2026-09-25T09:20:00.000Z",
          reviewRound: 1,
          findingCount: 2,
          resolvedCount: 1,
          acceptedCount: 1,
          testResults,
        },
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ summary: SUMMARY, events }))),
    );
    const { container } = render(<DarkFactoryRunDetailPage />);
    await waitFor(() =>
      expect(container.textContent).toContain("adds numbers"),
    );
    expect(container.textContent).toContain("throws on null");
    expect(container.textContent).toContain("1 passed");
    expect(container.textContent).toContain("1 failed");
  });

  it("renders the captured agent trace from a review-round event", async () => {
    const trace = [
      {
        acId: "AC1",
        description: "adds numbers",
        testFile: "src/foo.test.ts",
        testCaseName: "adds numbers",
        passed: true,
      },
      {
        acId: "AC2",
        description: "throws on null",
        testFile: "src/bar.test.ts",
        testCaseName: "throws on null",
        passed: false,
      },
    ];
    const events = [
      ...EVENTS,
      {
        sequence: 2,
        event: {
          eventId: "evt-review-trace",
          runId: "df-1a2b",
          type: "review.round",
          stage: "review",
          occurredAt: "2026-09-25T09:20:00.000Z",
          reviewRound: 1,
          findingCount: 2,
          resolvedCount: 1,
          acceptedCount: 1,
          trace,
        },
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ summary: SUMMARY, events }))),
    );
    const { container } = render(<DarkFactoryRunDetailPage />);
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="agent-trace"]'),
      ).not.toBeNull(),
    );
    expect(container.textContent).toContain("AC1");
    expect(container.textContent).toContain("throws on null");
    expect(container.textContent).toContain("1 verified");
    expect(container.textContent).toContain("1 unverified");
  });
});
