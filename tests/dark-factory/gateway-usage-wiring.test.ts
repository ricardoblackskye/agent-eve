import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A source guard on the gateway's wiring (#532), the repo's convention where behaviour lives behind a
 * seam that is unit-tested and what needs pinning is what the code actually calls.
 *
 * Two files, because the split is the design: the MODULE makes the governed call and owns the
 * measurement, while the ROUTE is the composition root that decides whether a sink exists at all.
 */
const MODULE = readFileSync(
  resolve(process.cwd(), "agent/lib/dark-factory/llm-gateway.ts"),
  "utf8",
);
const ROUTE = readFileSync(resolve(process.cwd(), "app/api/llm-gateway/route.ts"), "utf8");

describe("the gateway records the sandbox's spend (#532)", () => {
  it("measures the forwarded call from the response, through the shared helper", () => {
    expect(MODULE).toContain("measureGatewayUsage(");
  });

  it("settles on the measured cost, so the reservation stops settling null", () => {
    expect(MODULE).toMatch(/costOf:/);
  });

  it("supplies a usage sink typed `developer` — the name the estimator's split uses", () => {
    expect(MODULE).toContain('taskType: "developer"');
    expect(MODULE).toContain("measurementOf:");
  });

  it("puts the measured fields on the record, leaving an unmeasured one absent", () => {
    expect(MODULE).toMatch(/tokensIn: measured\.tokensIn/);
    expect(MODULE).toMatch(/costUsd: measured\.costUsd/);
  });

  it("keeps recording OPT-IN: the sink is a factory the composition root supplies", () => {
    expect(MODULE).toContain("workerUsage");
    expect(ROUTE).toContain("createWorkerUsageRecorder(");
  });
});
