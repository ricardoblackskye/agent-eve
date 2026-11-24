// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import DarkFactoryRunsPage from "../../app/dark-factory/runs/page";
import { formatDateTime } from "../../app/dark-factory/ui/format";
import { renderWithQuery } from "../support/render-with-query";

const UPDATED_AT = "2026-11-01T14:32:00.000Z";

const RUN = {
  runId: "df-1a2b",
  repo: "owner/repo",
  issue: 198,
  status: "succeeded",
  stage: "terminal",
  createdAt: "2026-09-25T09:14:00.000Z",
  updatedAt: UPDATED_AT,
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

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ runs: [RUN], total: 1 }),
    } as unknown as Response),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("the run row shows its date and time (#748 task 3)", () => {
  it("renders the one field on the row itself", async () => {
    const { container } = renderWithQuery(<DarkFactoryRunsPage />);
    await waitFor(() => expect(container.textContent).toContain("df-1a2b"));
    // Expected through the same formatter the four formatter tests pin, so this cannot
    // drift from the agreed shape and cannot depend on the runner's timezone.
    expect(container.textContent).toContain(formatDateTime(UPDATED_AT));
  });
});
