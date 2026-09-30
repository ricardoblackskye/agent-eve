"use client";

import type { UsageReport } from "../../../agent/lib/dark-factory/usage-query";
import { useRunQuery } from "./use-run-query";

export interface UsageResponse {
  report: UsageReport;
}

export const USAGE_PATH = "/api/dark-factory/usage";

export interface UsageWindow {
  /** Inclusive lower bound; omit for all time. */
  from?: string;
  /** Exclusive upper bound; omit for all time. */
  to?: string;
}

/** Operator-only, read-only usage read; polls like the other panels. */
export function useUsage(window: UsageWindow = {}) {
  const params = new URLSearchParams();
  if (window.from) params.set("from", window.from);
  if (window.to) params.set("to", window.to);
  const query = params.toString();
  return useRunQuery<UsageResponse>(query ? `${USAGE_PATH}?${query}` : USAGE_PATH);
}