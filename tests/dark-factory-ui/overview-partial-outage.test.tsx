// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dark-factory",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: unknown; href?: string }) => (
    <a href={href}>{children as never}</a>
  ),
}));

import DarkFactoryOverviewPage from "../../app/dark-factory/page";
import type { CostBudgetReport } from "../../agent/lib/dark-factory/cost-budget-query";
import type { UsageReport } from "../../agent/lib/dark-factory/usage-query";

/**
 * #427 — the overview page must survive ONE source being down.
 *
 * The reported failure: main's board rendered NOTHING but an error panel, losing the LLM cost and usage tiles,
 * because the page treats a run-history outage as a reason to replace the whole page. Those two panels are served
 * by different stores, which were healthy and answering 200 with real data.
 *
 * This reproduces it at the level it was REPORTED (a rendered page, one dead store) rather than unit-testing the
 * decision function, because the defect was never in the decision alone — it was in letting a decision about two
 * sources destroy panels belonging to four others.
 */

const USAGE: UsageReport = {
  totals: { calls: 3, costUsd: 1.25, tokensIn: 100, tokensOut: 50 },
  byModel: [{ model: "deepseek/deepseek-chat", calls: 2, costUsd: 1 }],
  byTaskType: [{ taskType: "developer", calls: 2, costUsd: 1 }],
  byDay: [{ date: "2026-09-30", calls: 3, costUsd: 1.25 }],
  byRun: [{ runId: "run-1", calls: 3, costUsd: 1.25 }],
  byTenant: [],
  unassigned: { calls: 0, unmeasured: 0 },
  unmeasured: 1,
};

const COST_BUDGETS: CostBudgetReport = {
  period: "2026-10",
  budgets: [
    {
      category: "orchestrator",
      period: "2026-10",
      capUsd: 10,
      spentUsd: 4,
      reservedUsd: 2,
      remainingUsd: 4,
      callCount: 7,
    },
  ],
  totals: { capUsd: 10, spentUsd: 4, reservedUsd: 2, remainingUsd: 4, callCount: 7 },
};

const RUN_HISTORY_DOWN = "Run history is unavailable";

function respond(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** The paths the page's containers fetch. Runs and metrics come from the run-history store; the rest do not. */
let requested: string[] = [];

beforeEach(() => {
  requested = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url);
      requested.push(path);
      // The dead store: run history backs BOTH of these.
      if (path.startsWith("/api/dark-factory/metrics")) return respond({ error: RUN_HISTORY_DOWN }, 503);
      if (path.startsWith("/api/dark-factory/runs")) return respond({ error: RUN_HISTORY_DOWN }, 503);
      // Independent stores, all healthy in the reported incident.
      if (path.startsWith("/api/dark-factory/usage")) return respond({ report: USAGE }, 200);
      if (path.startsWith("/api/dark-factory/cost-budgets")) return respond({ report: COST_BUDGETS }, 200);
      if (path.startsWith("/api/dark-factory/tenants")) return respond({ tenants: [] }, 200);
      return respond({ error: "not stubbed by this test" }, 503);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("#427 the overview page with one store down", () => {
  it("still renders the panels served by the healthy stores", async () => {
    render(<DarkFactoryOverviewPage />);

    // Both of these were reported as gone from the board.
    await waitFor(() => expect(screen.getAllByText("LLM USAGE").length).toBeGreaterThan(0));
    expect(screen.getAllByText("LLM COST BUDGETS").length).toBeGreaterThan(0);
  });

  it("gets the healthy data onto the screen, not just the panel shell", async () => {
    render(<DarkFactoryOverviewPage />);

    // Proof the healthy source was allowed through rather than merely not-erroring.
    await waitFor(() =>
      expect(screen.getAllByText("deepseek/deepseek-chat").length).toBeGreaterThan(0),
    );
  });

  it("says the failed source is unavailable rather than rendering run data as zeros", async () => {
    render(<DarkFactoryOverviewPage />);

    // Asserted TOGETHER with a healthy panel: on the buggy page the unavailable text also appeared, as the whole
    // page — so matching it alone would pass against the defect rather than describe the fix.
    await waitFor(() => expect(screen.getAllByText("LLM USAGE").length).toBeGreaterThan(0));
    expect(screen.getAllByText(new RegExp(RUN_HISTORY_DOWN)).length).toBeGreaterThan(0);
  });

  it("asks the run-history store, so the failure above is a real one and not a stub artefact", async () => {
    render(<DarkFactoryOverviewPage />);

    await waitFor(() =>
      expect(requested.some((p) => p.startsWith("/api/dark-factory/metrics"))).toBe(true),
    );
    // Awaited too: the containers mount their own effects after the page's, so this request lands a tick later.
    await waitFor(() =>
      expect(requested.some((p) => p.startsWith("/api/dark-factory/usage"))).toBe(true),
    );
  });
});