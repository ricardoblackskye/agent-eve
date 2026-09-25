// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRunQuery } from "../../app/dark-factory/ui/use-run-query";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useRunQuery", () => {
  it("loads data and clears loading on 200", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ runs: [] }));
    const { result } = renderHook(() =>
      useRunQuery<{ runs: unknown[] }>("/api/dark-factory/runs", {
        fetcher,
        intervalMs: 0,
      }),
    );
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ runs: [] });
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("surfaces an error and clears data on 401", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "Authentication required" }, 401),
      );
    const { result } = renderHook(() =>
      useRunQuery("/api/dark-factory/runs", { fetcher, intervalMs: 0 }),
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toMatch(/auth/i);
    expect(result.current.data).toBeNull();
  });

  it("surfaces a network error", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() =>
      useRunQuery("/x", { fetcher, intervalMs: 0 }),
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toBeNull();
  });

  it("refetches on refresh()", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ n: 1 }))
      .mockResolvedValueOnce(jsonResponse({ n: 2 }));
    const { result } = renderHook(() =>
      useRunQuery<{ n: number }>("/x", { fetcher, intervalMs: 0 }),
    );
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("polls on the configured interval", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ n: 1 }));
    renderHook(() => useRunQuery("/x", { fetcher, intervalMs: 20 }));
    await waitFor(
      () => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2),
      {
        timeout: 2000,
      },
    );
  });

  it("stops polling after unmount", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ n: 1 }));
    const { unmount } = renderHook(() =>
      useRunQuery("/x", { fetcher, intervalMs: 20 }),
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    unmount();
    const callsAfterUnmount = fetcher.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fetcher.mock.calls.length).toBe(callsAfterUnmount);
  });

  it("does not fetch when the path is null", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}));
    const { result } = renderHook(() =>
      useRunQuery(null, { fetcher, intervalMs: 0 }),
    );
    expect(result.current.loading).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
