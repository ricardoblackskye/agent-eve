"use client";

import type { UsageReport } from "../../../agent/lib/dark-factory/usage-query";
import type { Tenant } from "../../../agent/lib/dark-factory/tenant";
import type { RepoAssignment } from "../../../agent/lib/dark-factory/tenant-store";
import { useRunQuery } from "./use-run-query";

export interface TenantsResponse {
  tenants: Tenant[];
  assignments: RepoAssignment[];
}

export interface TenantUsageResponse {
  report: UsageReport;
}

export const TENANTS_PATH = "/api/dark-factory/tenants";
export const USAGE_PATH = "/api/dark-factory/usage";

export interface TenantUsageWindow {
  /** Inclusive lower bound; omit for all time. */
  from?: string;
  /** Exclusive upper bound; omit for all time. */
  to?: string;
}

/**
 * Operator-only, read-only tenant usage read.
 *
 * Fetches the registry and the usage report together so the panel can label
 * each row with a customer NAME while falling back to the opaque id for a
 * tenant it does not know about — a rename must never blank out a row, and an
 * unknown id must stay visible rather than disappear from the report.
 */
export function useTenantUsage(window: TenantUsageWindow = {}) {
  const params = new URLSearchParams();
  if (window.from) params.set("from", window.from);
  if (window.to) params.set("to", window.to);
  const query = params.toString();

  const registry = useRunQuery<TenantsResponse>(TENANTS_PATH);
  const usage = useRunQuery<TenantUsageResponse>(
    query ? `${USAGE_PATH}?${query}` : USAGE_PATH,
  );

  return {
    tenants: registry.data?.tenants ?? [],
    assignments: registry.data?.assignments ?? [],
    report: usage.data?.report ?? null,
    loading: registry.loading || usage.loading,
    error: registry.error ?? usage.error,
    refresh: () => {
      registry.refresh();
      usage.refresh();
    },
  };
}