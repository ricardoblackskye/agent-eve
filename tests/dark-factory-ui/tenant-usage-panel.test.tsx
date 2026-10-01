// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TenantUsagePanel } from "../../app/dark-factory/ui/tenant-usage-panel";
import type { UsageReport } from "../../agent/lib/dark-factory/usage-query";
import type { Tenant } from "../../agent/lib/dark-factory/tenant";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const tenants: Tenant[] = [
  {
    id: T1,
    slug: "acme",
    name: "Acme",
    status: "active",
    createdAt: "2026-09-24T12:00:00.000Z",
  },
  {
    id: T2,
    slug: "globex",
    name: "Globex",
    status: "active",
    createdAt: "2026-09-24T12:00:00.000Z",
  },
];

const report: UsageReport = {
  totals: { calls: 4, costUsd: 1.25 },
  byModel: [],
  byDay: [],
  byRun: [],
  byTenant: [
    { tenantId: T1, calls: 2, costUsd: 1.0, tokensIn: 100, tokensOut: 50, unmeasured: 1 },
    // Globex reported calls but NO cost — so its cost must render `—`.
    { tenantId: T2, calls: 1, unmeasured: 0 },
  ],
  unassigned: { calls: 1, costUsd: 0.25, unmeasured: 0 },
  unmeasured: 1,
};

function renderPanel(overrides: Partial<Parameters<typeof TenantUsagePanel>[0]> = {}) {
  return render(
    <TenantUsagePanel
      report={report}
      tenants={tenants}
      loading={false}
      error={null}
      onRefresh={vi.fn()}
      {...overrides}
    />,
  );
}

function rowFor(name: string): HTMLElement {
  const header = screen.getByRole("rowheader", { name });
  const row = header.closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("TenantUsagePanel", () => {
  it("lists each customer by name plus the unassigned bucket", () => {
    renderPanel();

    expect(screen.getByRole("rowheader", { name: "Acme" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Globex" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Unassigned" })).toBeTruthy();
  });

  it("renders an unmeasured cost as an em dash, never as zero", () => {
    renderPanel();

    const cells = within(rowFor("Globex")).getAllByRole("cell");
    // Customer | Calls | Tokens in | Tokens out | Cost | Unmeasured
    expect(cells[3]?.textContent).toBe("—");
    expect(cells[3]?.textContent).not.toBe("$0.00");
  });

  it("shows a measured cost for the customer that reported one", () => {
    renderPanel();
    expect(within(rowFor("Acme")).getByText("$1.00")).toBeTruthy();
  });

  it("keeps the unassigned bucket visible even when one customer is selected", () => {
    renderPanel({ selectedTenantId: T2 });

    expect(screen.queryByRole("rowheader", { name: "Acme" })).toBeNull();
    expect(screen.getByRole("rowheader", { name: "Globex" })).toBeTruthy();
    // Unattributed spend is not any customer's spend — it must never vanish
    // just because the operator narrowed the view to one customer.
    expect(screen.getByRole("rowheader", { name: "Unassigned" })).toBeTruthy();
  });

  it("reports the selected customer to its container", () => {
    const onSelectTenant = vi.fn();
    renderPanel({ onSelectTenant });

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: T2 },
    });

    expect(onSelectTenant).toHaveBeenCalledWith(T2);
  });

  it("clears the selection back to all customers", () => {
    const onSelectTenant = vi.fn();
    renderPanel({ selectedTenantId: T2, onSelectTenant });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });

    expect(onSelectTenant).toHaveBeenCalledWith(undefined);
  });

  it("shows a loading state before any report arrives", () => {
    renderPanel({ report: null, tenants: [], loading: true });
    expect(screen.getByText(/loading usage/i)).toBeTruthy();
  });

  it("shows an empty state when nothing has been recorded", () => {
    renderPanel({
      report: {
        totals: { calls: 0 },
        byModel: [],
        byDay: [],
        byRun: [],
        byTenant: [],
        unassigned: { calls: 0, unmeasured: 0 },
        unmeasured: 0,
      },
    });
    expect(screen.getByText(/no usage recorded/i)).toBeTruthy();
  });

  it("surfaces the error and refreshes on demand", () => {
    const onRefresh = vi.fn();
    renderPanel({ report: null, tenants: [], error: "registry down", onRefresh });

    expect(screen.getByRole("alert").textContent).toBe("registry down");
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});