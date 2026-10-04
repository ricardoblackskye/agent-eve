// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFactoryControl } from "../../app/dark-factory/ui/use-factory-control";

const snapshot = { available: true, factory: { paused: false, updatedAt: "2026-09-29T10:00:00.000Z" }, events: [] };
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe("useFactoryControl", () => {
  it("loads factory state and reports a 401 as unauthenticated", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(snapshot)).mockResolvedValueOnce(response({}, 401));
    const { result } = renderHook(() => useFactoryControl({ intervalMs: 0, fetcher }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(snapshot);
    await act(async () => { await result.current.refresh(); });
    expect(result.current.unauthenticated).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it("surfaces the server error message on a 503 body", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(response({ error: "Control state is unavailable" }, 503));
    const { result } = renderHook(() =>
      useFactoryControl({ intervalMs: 0, fetcher }),
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBe("Control state is unavailable");
  });

  it("posts the selected pause action and refreshes state", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(snapshot))
      .mockResolvedValueOnce(response({ state: { paused: true } }))
      .mockResolvedValueOnce(response({ ...snapshot, factory: { paused: true, updatedAt: snapshot.factory.updatedAt } }));
    const { result } = renderHook(() => useFactoryControl({ intervalMs: 0, fetcher }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.act("pause", "factory"); });
    expect(fetcher.mock.calls[1][0]).toBe("/api/dark-factory/control");
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify({ action: "pause", scope: "factory" }) });
    expect(result.current.data?.factory?.paused).toBe(true);
  });
});
