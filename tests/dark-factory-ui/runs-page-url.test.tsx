// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  search: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.push }),
  useSearchParams: () => nav.search,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

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

const many = Array.from({ length: 45 }, (_, index) => ({ ...RUN, runId: `df-${index}` }));

let calls: string[] = [];

function stubFetch(runs: unknown[], nextCursor: string | null = null) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(String(url));
      return Promise.resolve(jsonResponse({ runs, nextCursor }));
    }),
  );
}

/** The last URL the page asked the router to show. */
function lastPush(): string {
  const calls = nav.push.mock.calls;
  return calls.length ? String(calls[calls.length - 1][0]) : "";
}

beforeEach(() => {
  nav.search = new URLSearchParams();
  nav.push.mockReset();
  nav.push.mockReset();
  stubFetch([RUN]);
});
afterEach(() => vi.unstubAllGlobals());

describe("the run list keeps its place in the URL (#748 task 4)", () => {
  it("puts the page size in the URL when the operator changes it", async () => {
    const { getByLabelText } = renderWithQuery(<DarkFactoryRunsPage />);
    fireEvent.change(getByLabelText("Rows per page"), { target: { value: "50" } });
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    expect(lastPush()).toContain("size=50");
  });

  it("puts the cursor in the URL when the operator pages forward", async () => {
    stubFetch(many, "tok-1");
    const { getByLabelText } = renderWithQuery(<DarkFactoryRunsPage />);
    await waitFor(() => {
      expect((getByLabelText("Next page") as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(getByLabelText("Next page"));
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    expect(lastPush()).toContain("cursor=tok-1");
  });

  it("opens the page the URL names, so a link is shareable", async () => {
    nav.search = new URLSearchParams("size=50");
    renderWithQuery(<DarkFactoryRunsPage />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toContain("limit=50");
  });
});
