// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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

const SEARCH = "Filter issue / repository / run id";

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(String(url));
      return Promise.resolve(jsonResponse({ runs: [RUN], nextCursor: null }));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("the run list filters on the server (#748 task 3.5)", () => {
  it("sends the typed term to the server", async () => {
    const { getByPlaceholderText } = renderWithQuery(<DarkFactoryRunsPage />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    fireEvent.change(getByPlaceholderText(SEARCH), { target: { value: "zzz" } });
    await waitFor(() => expect(calls.some((url) => url.includes("search=zzz"))).toBe(true));
  });

  it("shows what the server returned even when the term does not match it", async () => {
    // The proof that the client stopped filtering: the server was asked, answered with this run,
    // and the row renders. A client-side filter would have dropped it, hiding the server's answer.
    const { getByPlaceholderText, container } = renderWithQuery(<DarkFactoryRunsPage />);
    await waitFor(() => expect(container.textContent).toContain("df-1a2b"));
    fireEvent.change(getByPlaceholderText(SEARCH), { target: { value: "no-such-run" } });
    await waitFor(() => expect(calls.some((url) => url.includes("search=no-such-run"))).toBe(true));
    expect(container.textContent).toContain("df-1a2b");
  });
});
