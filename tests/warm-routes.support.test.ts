/**
 * #473 — the warm-up rules that keep a cold E2E run honest.
 *
 * A 4xx proves a route compiled; a 5xx does not. A target that never succeeds must throw, so a
 * broken warm-up cannot masquerade as a fixed race.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WARM_ATTEMPTS,
  warmRoutes,
  type WarmOptions,
} from "./support/warm-routes";

const noSleep: NonNullable<WarmOptions["sleep"]> = async () => {};

function opts(extra: WarmOptions = {}): WarmOptions {
  return { sleep: noSleep, ...extra };
}

describe("#473 warm-up attempts", () => {
  it("requests each target once, de-duplicated and in order", async () => {
    // Typed explicitly: `vi.fn(async () => 200)` infers a zero-argument mock, so `call[0]`
    // would not type-check even though the module calls it with a path.
    const request = vi.fn<(path: string) => Promise<number>>(async () => 200);

    await warmRoutes(["/a", "/b", "/a"], request, opts());

    expect(request.mock.calls.map((call) => call[0])).toEqual(["/a", "/b"]);
  });

  it("defaults to three attempts per target", () => {
    expect(DEFAULT_WARM_ATTEMPTS).toBe(3);
  });

  it("honours a custom attempt budget", async () => {
    const request = vi.fn(async () => 500);

    await expect(
      warmRoutes(["/a"], request, opts({ attempts: 2 })),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("#473 what counts as warmed", () => {
  it("counts a 2xx as warmed", async () => {
    const report = await warmRoutes(["/a"], async () => 200, opts());

    expect(report.warmed).toEqual([{ path: "/a", status: 200, attempts: 1 }]);
  });

  it("counts a 404 as warmed, because the route still compiled", async () => {
    const report = await warmRoutes(
      ["/dark-factory/runs/does-not-exist-999"],
      async () => 404,
      opts(),
    );

    expect(report.warmed).toEqual([
      {
        path: "/dark-factory/runs/does-not-exist-999",
        status: 404,
        attempts: 1,
      },
    ]);
  });

  it("retries a 5xx and then throws, naming the route", async () => {
    const request = vi.fn(async () => 503);

    await expect(warmRoutes(["/boom"], request, opts())).rejects.toThrow(
      /\/boom/,
    );
    expect(request).toHaveBeenCalledTimes(DEFAULT_WARM_ATTEMPTS);
  });

  it("retries a thrown request error rather than swallowing it", async () => {
    let calls = 0;
    const request = async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNRESET");
      return 200;
    };

    const report = await warmRoutes(["/a"], request, opts());

    expect(report.warmed).toEqual([{ path: "/a", status: 200, attempts: 3 }]);
  });

  it("throws when every attempt throws, naming the route", async () => {
    const request = async () => {
      throw new Error("ECONNRESET");
    };

    await expect(warmRoutes(["/a"], request, opts())).rejects.toThrow(/\/a/);
  });

  it("waits between failed attempts rather than hammering", async () => {
    const sleep = vi.fn(async () => {});
    const request = vi.fn(async () => 500);

    await expect(
      warmRoutes(
        ["/a"],
        request,
        opts({ sleep, attempts: 3, retryDelayMs: 10 }),
      ),
    ).rejects.toThrow();

    // Two gaps for three attempts — never a sleep after the final failure.
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
