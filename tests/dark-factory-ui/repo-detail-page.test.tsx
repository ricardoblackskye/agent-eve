// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, params } = vi.hoisted(() => ({
  push: vi.fn(),
  params: { owner: "ricardoblackskye", name: "agent-eve" },
}));
vi.mock("next/navigation", () => ({
  useParams: () => params,
  useRouter: () => ({ push }),
}));

import RepoDetailPage from "../../app/dark-factory/repos/[owner]/[name]/page";

/**
 * #414 (epic #403 R2) — the repo detail page, which is what R1's list links to.
 *
 * These assert the REQUEST the page makes, not the table it renders: the whole point of this release is that the
 * ORDER is asked for at the API boundary, and a browser-side sort over one fetched page would lie about every page
 * it cannot see. The last test pins the defect that made this a task - R1 shipped rows linking here while the route
 * did not exist.
 */
const RUNS = [
  {
    runId: "df-1a2b",
    repo: "ricardoblackskye/agent-eve",
    issue: 414,
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
  },
];

const requested: string[] = [];

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  requested.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requested.push(String(url));
      const cursor = new URL(String(url), "http://localhost").searchParams.get("cursor");
      return cursor
        ? respond({ runs: [], nextCursor: null })
        : respond({ runs: RUNS, nextCursor: "cursor-page-2" });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe("#414 the repo detail page", () => {
  it("asks the API for THAT repo, ordered, rather than filtering in the browser", async () => {
    render(<RepoDetailPage />);

    await waitFor(() => expect(requested.length).toBeGreaterThan(0));
    const url = new URL(requested[0], "http://localhost");
    expect(url.pathname).toBe("/api/dark-factory/runs");
    expect(url.searchParams.get("repo")).toBe("ricardoblackskye/agent-eve");
    expect(url.searchParams.get("sort")).toBe("createdAt");
    expect(url.searchParams.get("direction")).toBe("desc");
  });

  it("names the repository it is showing", async () => {
    render(<RepoDetailPage />);
    // A heading, not any text: the repository name also appears inside the readiness panel, and a matcher that
    // accepted either would pass even if the page lost its own title.
    expect(
      screen.getByRole("heading", { name: /ricardoblackskye\/agent-eve/ }),
    ).toBeTruthy();
  });

  it("re-requests with the other direction when the order is reversed", async () => {
    render(<RepoDetailPage />);
    await waitFor(() => expect(requested.length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: /oldest first/i }));

    await waitFor(() =>
      expect(
        requested.some(
          (u) => new URL(u, "http://localhost").searchParams.get("direction") === "asc",
        ),
      ).toBe(true),
    );
  });

  it("follows the cursor for the next page, and comes back for the previous one", async () => {
    render(<RepoDetailPage />);
    await waitFor(() => expect(requested.length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() =>
      expect(
        requested.some((u) => new URL(u, "http://localhost").searchParams.get("cursor") === "cursor-page-2"),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole("button", { name: /previous/i }));
    await waitFor(() => {
      const last = new URL(requested.at(-1) ?? "http://localhost", "http://localhost");
      expect(last.searchParams.get("cursor")).toBeNull();
    });
  });

  it("hosts the readiness scale for the repository it is showing", async () => {
    render(<RepoDetailPage />);
    await waitFor(() =>
      expect(screen.getByText(/level 4 \(optimized\)/i)).toBeTruthy(),
    );
  });
});
