// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import DarkFactoryRunsPage from "../../app/dark-factory/runs/page";
import { renderWithQuery } from "../support/render-with-query";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const RUN = {
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

const many = Array.from({ length: 45 }, (_, index) => ({
  ...RUN,
  runId: `df-${index}`,
}));

let calls: string[] = [];

function stubFetch(runs: unknown[]) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(String(url));
      return Promise.resolve(jsonResponse({ runs, total: runs.length }));
    }),
  );
}

beforeEach(() => stubFetch([RUN]));
afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe("runs page paging (#748 task 3)", () => {
  it("asks the server for the first page of twenty by default", async () => {
    renderWithQuery(<DarkFactoryRunsPage />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toContain("limit=20");
    expect(calls[0]).toContain("offset=0");
  });

  it("offers twenty, fifty and one hundred rows per page", () => {
    const { getByLabelText } = renderWithQuery(<DarkFactoryRunsPage />);
    const select = getByLabelText("Rows per page") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["20", "50", "100"]);
  });

  it("disables both arrows when everything fits on one page", async () => {
    const { getByLabelText } = renderWithQuery(<DarkFactoryRunsPage />);
    await waitFor(() => {
      expect((getByLabelText("Previous page") as HTMLButtonElement).disabled).toBe(true);
    });
    expect((getByLabelText("Next page") as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for the next page's offset, and keeps the page size", async () => {
    stubFetch(many);
    const { getByLabelText } = renderWithQuery(<DarkFactoryRunsPage />);
    await waitFor(() => {
      expect((getByLabelText("Next page") as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(getByLabelText("Next page"));
    await waitFor(() => expect(calls.some((url) => url.includes("offset=20"))).toBe(true));
    expect(calls[calls.length - 1]).toContain("limit=20");
  });

  it("returns to the first page when the page size changes", async () => {
    stubFetch(many);
    const { getByLabelText } = renderWithQuery(<DarkFactoryRunsPage />);
    await waitFor(() => {
      expect((getByLabelText("Next page") as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(getByLabelText("Next page"));
    await waitFor(() => expect(calls.some((url) => url.includes("offset=20"))).toBe(true));
    fireEvent.change(getByLabelText("Rows per page"), { target: { value: "50" } });
    await waitFor(() => {
      expect(calls[calls.length - 1]).toContain("limit=50");
    });
    expect(calls[calls.length - 1]).toContain("offset=0");
  });
});
