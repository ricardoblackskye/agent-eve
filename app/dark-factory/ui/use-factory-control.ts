"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readErrorMessage } from "./use-run-query";
import type {
  ControlAction,
  ControlEvent,
  ControlScope,
  FactoryControlState,
  RunControlState,
} from "../../../agent/lib/dark-factory/control";

export interface ControlSnapshot {
  available: boolean;
  factory: FactoryControlState | null;
  runId?: string;
  run?: RunControlState | null;
  events: ControlEvent[];
}

export interface FactoryControlStateView {
  data: ControlSnapshot | null;
  loading: boolean;
  error: string | null;
  unauthenticated: boolean;
  pending: boolean;
  refresh: () => Promise<void>;
  act: (action: ControlAction, scope: ControlScope, reason?: string) => Promise<void>;
}

export function useFactoryControl(options: {
  runId?: string;
  intervalMs?: number;
  fetcher?: typeof fetch;
} = {}): FactoryControlStateView {
  const { runId, intervalMs = 60_000, fetcher } = options;
  const path = runId
    ? `/api/dark-factory/control?runId=${encodeURIComponent(runId)}`
    : "/api/dark-factory/control";
  const [data, setData] = useState<ControlSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauthenticated, setUnauthenticated] = useState(false);
  const mounted = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    try {
      const response = await (fetcherRef.current ?? globalThis.fetch)(path, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!mounted.current) return;
      if (response.status === 401) {
        setUnauthenticated(true);
        setData(null);
        setError(null);
      } else if (!response.ok) {
        setUnauthenticated(false);
        setData(null);
        setError(await readErrorMessage(response));
      } else {
        const body = (await response.json()) as ControlSnapshot;
        if (!mounted.current) return;
        setData(body);
        setError(null);
        setUnauthenticated(false);
      }
    } catch {
      if (!mounted.current) return;
      setData(null);
      setError("Network error");
      setUnauthenticated(false);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [path]);

  const act = useCallback(
    async (action: ControlAction, scope: ControlScope, reason?: string) => {
      setPending(true);
      setError(null);
      try {
        const body = { action, scope, ...(runId ? { runId } : {}), ...(reason ? { reason } : {}) };
        const response = await (fetcherRef.current ?? globalThis.fetch)("/api/dark-factory/control", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          cache: "no-store",
          body: JSON.stringify(body),
        });
        if (response.status === 401) {
          setUnauthenticated(true);
          setData(null);
          return;
        }
        if (!response.ok) {
          setError(await readErrorMessage(response));
          return;
        }
        await refresh();
      } catch {
        setError("Network error");
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [refresh, runId],
  );

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!intervalMs) return;
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, refresh]);

  return { data, loading, error, unauthenticated, pending, refresh, act };
}
