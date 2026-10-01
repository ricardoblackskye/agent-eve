"use client";

import { useState } from "react";
import type { UsageReport } from "../../../agent/lib/dark-factory/usage-query";
import type { UsageTenantTotals } from "../../../agent/lib/dark-factory/usage-store";
import type { Tenant } from "../../../agent/lib/dark-factory/tenant";
import { formatCostUsd } from "./format";
import { useTenantUsage } from "./use-tenant-usage";

/** A value that was never measured renders as an em dash, never as 0. */
const UNMEASURED = "—";

function count(value: number | undefined): string {
  return value === undefined ? UNMEASURED : String(value);
}

export interface TenantUsagePanelProps {
  report: UsageReport | null;
  tenants: Tenant[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  selectedTenantId?: string;
  onSelectTenant?: (tenantId: string | undefined) => void;
}

/**
 * Read-only operator view of LLM usage BY CUSTOMER TENANT.
 *
 * Counts only — no prompt or completion content is ever shown. Two things this
 * panel exists to get right:
 *
 *  - The UNASSIGNED bucket is always its own row, even when a single customer
 *    is selected. Unattributed spend is not any customer's spend; hiding it
 *    would lose the money, and folding it into a customer's row would overstate
 *    what they owe.
 *  - An unmeasured sum renders as `—`, never `$0.00` or `0`: a zero reads as
 *    "this cost nothing" when the truth is "nobody measured it".
 */
export function TenantUsagePanel({
  report,
  tenants,
  loading,
  error,
  onRefresh,
  selectedTenantId,
  onSelectTenant,
}: TenantUsagePanelProps) {
  const rows = report
    ? report.byTenant.filter(
        (row) => selectedTenantId === undefined || row.tenantId === selectedTenantId,
      )
    : [];
  const empty =
    report !== null && report.totals.calls === 0 && report.unmeasured === 0;

  /** Prefer the customer's name; fall back to the opaque id, never to a blank. */
  function label(tenantId: string | undefined): string {
    if (tenantId === undefined) return "Unassigned";
    return tenants.find((tenant) => tenant.id === tenantId)?.name ?? tenantId;
  }

  function row(key: string, bucket: UsageTenantTotals, name: string, className?: string) {
    return (
      <tr key={key} className={className}>
        <th scope="row">{name}</th>
        <td>{bucket.calls}</td>
        <td>{count(bucket.tokensIn)}</td>
        <td>{count(bucket.tokensOut)}</td>
        <td>{formatCostUsd(bucket.costUsd)}</td>
        <td>{bucket.unmeasured}</td>
      </tr>
    );
  }

  return (
    <section className="df-usage-card" aria-label="Customer usage">
      <header className="df-usage-head">
        <h2>Customer usage</h2>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </header>

      <label className="df-tenant-select">
        Customer
        <select
          value={selectedTenantId ?? ""}
          onChange={(event) =>
            onSelectTenant?.(event.target.value === "" ? undefined : event.target.value)
          }
        >
          <option value="">All customers</option>
          {tenants.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>
              {tenant.name}
            </option>
          ))}
        </select>
      </label>

      {loading && !report ? <p>Loading usage…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {empty ? <p>No usage recorded.</p> : null}

      {report && !empty ? (
        <table className="df-usage-table">
          <caption>By customer</caption>
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col">Calls</th>
              <th scope="col">Tokens in</th>
              <th scope="col">Tokens out</th>
              <th scope="col">Cost</th>
              <th scope="col">Unmeasured</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((bucket) =>
              row(
                bucket.tenantId ?? "unassigned-row",
                bucket,
                label(bucket.tenantId),
              ),
            )}
            {row(
              "unassigned",
              report.unassigned,
              "Unassigned",
              "df-tenant-unassigned",
            )}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

/** Container that reads the tenant usage APIs and feeds the presentational panel. */
export function TenantUsagePanelContainer() {
  const { report, tenants, loading, error, refresh } = useTenantUsage();
  const [selectedTenantId, setSelectedTenantId] = useState<string | undefined>(
    undefined,
  );

  return (
    <TenantUsagePanel
      report={report}
      tenants={tenants}
      loading={loading}
      error={error}
      onRefresh={refresh}
      selectedTenantId={selectedTenantId}
      onSelectTenant={setSelectedTenantId}
    />
  );
}