// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A controllable location, so a case can state the URL the page is opened with.
const nav = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  search: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
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

function lastPush(): string {
  const made = nav.push.mock.calls;
  return made.length ? String(made[made.length - 1][0]) : "";
}

beforeEach(() => {
  nav.search = new URLSearchParams();
  nav.push.mockReset();
  nav.replace.mockReset();
  stubFetch([RUN]);
});
afterEach(() => vi.unstubAllGlobals());

describe("the run list asks by cursor (#748 task 4)", () => {
  // The read side. No case here simulates navigation: that is the browser s job, and faking it
  // turned the mock into the problem instead of the page.
  it("asks with the cursor the URL names, so a page link is shareable", async () => {
    nav.search = new URLSearchParams("cursor=tok-1");
    stubFetch(many, "tok-1");
    renderWithQuery(<DarkFactoryRunsPage />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toContain("cursor=tok-1");
  });

  it("asks the first page by size alone, and never by offset", async () => {
    stubFetch(many, "tok-1");
    renderWithQuery(<DarkFactoryRunsPage />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toContain("limit=20");
    expect(calls[0]).not.toContain("offset");
    expect(calls[0]).not.toContain("cursor");
  });

  it("drops the cursor when the page size changes", async () => {
    nav.search = new URLSearchParams("cursor=tok-1");
    stubFetch(many, "tok-1");
    const { getByLabelText } = renderWithQuery(<DarkFactoryRunsPage />);
    fireEvent.change(getByLabelText("Rows per page"), { target: { value: "50" } });
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    expect(lastPush()).toContain("size=50");
    expect(lastPush()).not.toContain("cursor");
  });

});
