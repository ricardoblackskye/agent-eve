import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A source guard on the gateway's wiring (#532), the repo's convention where behaviour lives behind a
 * seam that is unit-tested and what needs pinning is the call the composition root actually makes.
 */
const ROUTE = readFileSync(resolve(process.cwd(), "app/api/llm-gateway/route.ts"), "utf8");

describe("the gateway records the sandbox's spend (#532)", () => {
  it("measures the forwarded call from the response, through the shared helper", () => {
    expect(ROUTE).toContain("measureGatewayUsage(");
  });

  it("settles on the measured cost, so the reservation stops settling null", () => {
    expect(ROUTE).toMatch(/costOf:/);
  });

  it("supplies the usage sink typed `developer` — the name the estimator's split uses", () => {
    expect(ROUTE).toContain('taskType: "developer"');
    expect(ROUTE).toContain("measurementOf:");
  });

  it("keeps recording OPT-IN: the sink comes from the worker-usage factory", () => {
    expect(ROUTE).toContain("createWorkerUsageRecorder(");
  });
});
