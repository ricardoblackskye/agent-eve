"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface RunQueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export interface UseRunQueryOptions {
  /** Poll interval in ms; 0 or undefined disables polling. Default 60_000. */
  intervalMs?: number;
  /** Injectable fetcher (defaults to the global fetch). */
  fetcher?: typeof fetch;
}

export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Reads a Dark Factory read-API path, exposes loading/error/data, refreshes on
 * demand, and polls on an interval. The response is never cached: a 401 yields
 * an explicit error so the board can withhold data from an unauthenticated
 * viewer.
 */
export function useRunQuery<T>(
  path: string | null,
  options: UseRunQueryOptions = {},
): RunQueryState<T> {
  const { intervalMs = DEFAULT_POLL_INTERVAL_MS, fetcher } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const fetchRef = useRef<() => void>(() => {});

  const runFetch = useCallback(async () => {
    if (!path) return;
    const doFetch = fetcher ?? globalThis.fetch;
    if (!doFetch) return;
    setLoading(true);
    try {
      const response = await doFetch(path, {
        headers: { accept: "application/json" },
      });
      if (!mountedRef.current) return;
      if (response.status === 401) {
        setError("Authentication required");
        setData(null);
      } else if (!response.ok) {
        setError(`Request failed with status ${response.status}`);
        setData(null);
      } else {
        const body = (await response.json()) as T;
        if (!mountedRef.current) return;
        setData(body);
        setError(null);
      }
    } catch {
      if (!mountedRef.current) return;
      setError("Network error");
      setData(null);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [path, fetcher]);

  fetchRef.current = () => {
    void runFetch();
  };

  useEffect(() => {
    mountedRef.current = true;
    void runFetch();
    return () => {
      mountedRef.current = false;
    };
  }, [runFetch]);

  useEffect(() => {
    if (!path || !intervalMs) return;
    const id = setInterval(() => fetchRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [path, intervalMs]);

  const refresh = useCallback(() => {
    void runFetch();
  }, [runFetch]);

  return { data, loading, error, refresh };
}
