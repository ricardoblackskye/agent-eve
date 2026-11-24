import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLL_INTERVAL_MS,
  runListRequest,
  runQueryOptions,
} from "../../app/dark-factory/ui/use-run-query";

describe("run list request (#748 task 2b, in cursor terms)", () => {
  it("takes the key and the path from one input, so they cannot drift", () => {
    const { key, path } = runListRequest({}, { size: 20 });
    const named = key[2] as { size: number; cursor?: string };
    expect(named.size).toBe(20);
    expect(path).toContain("limit=20");
    expect(path.startsWith("/api/dark-factory/runs?")).toBe(true);
    expect(path).not.toContain("offset");
  });

  it("puts the same cursor in the key and in the path", () => {
    const { key, path } = runListRequest({}, { size: 20, cursor: "tok-1" });
    expect((key[2] as { cursor?: string }).cursor).toBe("tok-1");
    expect(path).toContain("cursor=tok-1");
    expect(path).not.toContain("offset");
  });

  it("carries the same filters in the key and in the path", () => {
    const { key, path } = runListRequest({ statuses: ["failed"] }, { size: 20 });
    expect((key[2] as { statuses?: string[] }).statuses).toEqual(["failed"]);
    expect(path).toContain("status=failed");
  });

  it("states the no-cache, no-retry posture rather than inheriting a default", () => {
    const options = runQueryOptions();
    expect(options.staleTime).toBe(0);
    expect(options.retry).toBe(false);
  });

  it("polls on the documented default interval, and can be switched off", () => {
    expect(runQueryOptions().refetchInterval).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(runQueryOptions(5_000).refetchInterval).toBe(5_000);
    expect(runQueryOptions(0).refetchInterval).toBeFalsy();
  });
});
