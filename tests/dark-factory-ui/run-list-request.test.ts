import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLL_INTERVAL_MS,
  runListRequest,
  runQueryOptions,
} from "../../app/dark-factory/ui/use-run-query";

describe("run list request (#748 task 2b)", () => {
  it("takes the key and the path from one input, so they cannot drift", () => {
    for (const paging of [
      { page: 1, size: 20 },
      { page: 3, size: 50 },
    ]) {
      const { key, path } = runListRequest({}, paging);
      const named = key[2] as { page: number; size: number };
      expect(named.page).toBe(paging.page);
      expect(named.size).toBe(paging.size);
      expect(path).toContain(`limit=${paging.size}`);
      expect(path).toContain(`offset=${(paging.page - 1) * paging.size}`);
      expect(path.startsWith("/api/dark-factory/runs?")).toBe(true);
    }
  });

  it("carries the same filters in the key and in the path", () => {
    const { key, path } = runListRequest({ statuses: ["failed"] }, { page: 1, size: 20 });
    expect((key[2] as { statuses?: string[] }).statuses).toEqual(["failed"]);
    expect(path).toContain("status=failed");
  });

  it("states the no-cache, no-retry posture rather than inheriting a default", () => {
    const options = runQueryOptions();
    expect(options.staleTime).toBe(0);
    expect(options.retry).toBe(false);
  });

  it("polls on the documented default interval", () => {
    expect(runQueryOptions().refetchInterval).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(runQueryOptions(5_000).refetchInterval).toBe(5_000);
  });

  it("disables polling when the interval is switched off", () => {
    expect(runQueryOptions(0).refetchInterval).toBeFalsy();
  });
});
