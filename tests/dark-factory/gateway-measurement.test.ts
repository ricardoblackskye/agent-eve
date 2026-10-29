import { describe, expect, it } from "vitest";
import { measureGatewayUsage } from "../../agent/lib/dark-factory/llm-gateway";

const MODEL = "deepseek/deepseek-v4.1-flash";
const PRICE = { inputUsdPer1k: 1, outputUsdPer1k: 2 };
const priced = () => PRICE;
const unpriced = () => null;

describe("measure a forwarded call (#532)", () => {
  it("reads the provider's own token counts from the OpenAI-compatible usage block", () => {
    const measured = measureGatewayUsage(
      { id: "gen-1", usage: { prompt_tokens: 1200, completion_tokens: 340 } },
      MODEL,
      priced,
    );
    expect(measured.tokensIn).toBe(1200);
    expect(measured.tokensOut).toBe(340);
  });

  it("also reads the input/output spelling, since the gateway fronts more than one provider", () => {
    const measured = measureGatewayUsage(
      { usage: { input_tokens: 900, output_tokens: 120 } },
      MODEL,
      priced,
    );
    expect(measured.tokensIn).toBe(900);
    expect(measured.tokensOut).toBe(120);
  });

  it("costs the call from the SAME price source a reservation uses", () => {
    const measured = measureGatewayUsage(
      { usage: { prompt_tokens: 1200, completion_tokens: 340 } },
      MODEL,
      priced,
    );
    expect(measured.costUsd).toBeCloseTo(1.88, 10);
  });

  it("leaves the cost ABSENT for an unpriced model, keeping the tokens it did measure", () => {
    const measured = measureGatewayUsage(
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      MODEL,
      unpriced,
    );
    expect(measured.tokensIn).toBe(10);
    expect(measured.costUsd).toBeUndefined();
  });

  it("yields absent fields, never zeros, for a response that carried no usage", () => {
    for (const body of [{ id: "x" }, { usage: null }, { usage: {} }, null, undefined, "nope", 42]) {
      const measured = measureGatewayUsage(body, MODEL, priced);
      expect(measured.tokensIn).toBeUndefined();
      expect(measured.tokensOut).toBeUndefined();
      expect(measured.costUsd).toBeUndefined();
    }
  });

  it("ignores a non-numeric token count rather than propagating it", () => {
    const measured = measureGatewayUsage(
      { usage: { prompt_tokens: "lots", completion_tokens: -1 } },
      MODEL,
      priced,
    );
    expect(measured.tokensIn).toBeUndefined();
    expect(measured.tokensOut).toBeUndefined();
  });

  it("is deterministic — the same response yields a byte-identical measurement", () => {
    const body = { usage: { prompt_tokens: 1200, completion_tokens: 340 } };
    expect(JSON.stringify(measureGatewayUsage(body, MODEL, priced))).toBe(
      JSON.stringify(measureGatewayUsage(body, MODEL, priced)),
    );
  });
});
