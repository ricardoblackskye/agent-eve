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

import type { AmmScan } from "../../agent/lib/dark-factory/amm-readiness";
import RepoDetailPage from "../../app/dark-factory/repos/[owner]/[name]/page";

/**
 * #414 (epic #403 R2) — the repo detail page, which is what R1's list links to.
 *
 * These assert the REQUEST the page makes, not the table it renders: the whole point of this release is that the
 * ORDER is asked for at the API boundary, and a browser-side sort over one fetched page would lie about every page
 * it cannot see. The last test pins the defect that made this a task - R1 shipped rows linking here while the route
 * did not exist.
 *
 * #465 — the readiness scan now arrives from `/api/dark-factory/amm-scans` rather than from an imported fixture, so
 * the stub below serves by PATH and the scale test renders a scan that exists ONLY in this response. That is what
 * makes it fail if the page ever goes back to reading the fixture.
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

/** Level 2, NOT the fixture's Level 4 Optimized / 74 points, so the assertion can tell them apart. */
const MEASURED: AmmScan = {
  repo: "ricardoblackskye/agent-eve",
  scannedAt: "2026-10-25T00:00:00.000Z",
  overall: { points: 19, maxPoints: 100, level: 2, label: "Level 2 (Documented)" },
  pillars: [],
  capabilities: [],
};

const requested: string[] = [];

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** The page asks two endpoints; the runs assertions must not accidentally count the readiness request. */
const runsRequests = (): string[] =>
  requested.filter((url) => url.includes("/api/dark-factory/runs"));

beforeEach(() => {
  requested.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requested.push(String(url));
      const parsed = new URL(String(url), "http://localhost");
      if (parsed.pathname === "/api/dark-factory/amm-scans") {
        return respond({ scan: MEASURED });
      }
      const cursor = parsed.searchParams.get("cursor");
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

    await waitFor(() => expect(runsRequests().length).toBeGreaterThan(0));
    const url = new URL(runsRequests()[0], "http://localhost");
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
    await waitFor(() => expect(runsRequests().length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: /oldest first/i }));

    await waitFor(() =>
      expect(
        runsRequests().some(
          (u) => new URL(u, "http://localhost").searchParams.get("direction") === "asc",
        ),
      ).toBe(true),
    );
  });

  it("follows the cursor for the next page, and comes back for the previous one", async () => {
    render(<RepoDetailPage />);
    await waitFor(() => expect(runsRequests().length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() =>
      expect(
        runsRequests().some(
          (u) => new URL(u, "http://localhost").searchParams.get("cursor") === "cursor-page-2",
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole("button", { name: /previous/i }));
    await waitFor(() => {
      const last = new URL(runsRequests().at(-1) ?? "http://localhost", "http://localhost");
      expect(last.searchParams.get("cursor")).toBeNull();
    });
  });

  it("renders the MEASURED scan from the readiness endpoint, not a fixture", async () => {
    render(<RepoDetailPage />);

    // It reaches the endpoint for this repo...
    await waitFor(() =>
      expect(
        requested.some(
          (u) =>
            u.includes("/api/dark-factory/amm-scans") &&
            new URL(u, "http://localhost").searchParams.get("repo") ===
              "ricardoblackskye/agent-eve",
        ),
      ).toBe(true),
    );
    // ...and shows what came back, which is a level the fixture does not carry.
    await waitFor(() => expect(screen.getByText(/level 2 \(documented\)/i)).toBeTruthy());
    expect(screen.queryByText(/level 4 \(optimized\)/i)).toBeNull();
  });
});
