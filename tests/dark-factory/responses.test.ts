import { describe, expect, it } from "vitest";
import { serviceUnavailable } from "../../app/api/dark-factory/responses";

describe("serviceUnavailable", () => {
  it("defaults to the run-history message and a 503 status", async () => {
    const response = serviceUnavailable();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Run history is unavailable",
    });
  });

  it("carries a store-specific message so the tile explains itself", async () => {
    const response = serviceUnavailable("Cost budgets are unavailable");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Cost budgets are unavailable",
    });
  });
});