import { describe, expect, it } from "vitest";
import {
  InvalidUsageEventError,
  MAX_USAGE_COST_USD,
  MAX_USAGE_TOKENS,
  toUsageEvent,
} from "../../agent/lib/dark-factory/usage-ledger";

const base = {
  runId: "run-1",
  taskType: "pr-review",
  model: "deepseek/deepseek-chat",
  ts: "2026-09-30T10:00:00.000Z",
};

describe("toUsageEvent", () => {
  it("omits unmeasured fields rather than zero-filling them", () => {
    const event = toUsageEvent({ ...base });
    expect(event).not.toHaveProperty("costUsd");
    expect(event).not.toHaveProperty("tokensIn");
    expect(event).not.toHaveProperty("tokensOut");
    expect(event).not.toHaveProperty("durationMs");
    expect(event).not.toHaveProperty("pbiId");
  });

  it("keeps a measured zero as zero", () => {
    expect(toUsageEvent({ ...base, costUsd: 0 }).costUsd).toBe(0);
    expect(toUsageEvent({ ...base, tokensOut: 0 }).tokensOut).toBe(0);
  });

  it("normalises the accepted fields", () => {
    const event = toUsageEvent({
      ...base,
      runId: "  run-1  ",
      pbiId: 209,
      tokensIn: 1200,
      tokensOut: 300,
      costUsd: 0.42,
      durationMs: 8400,
    });
    expect(event).toEqual({
      runId: "run-1",
      pbiId: 209,
      taskType: "pr-review",
      model: "deepseek/deepseek-chat",
      tokensIn: 1200,
      tokensOut: 300,
      costUsd: 0.42,
      durationMs: 8400,
      ts: "2026-09-30T10:00:00.000Z",
    });
  });

  it("rejects a negative or absurd token count", () => {
    expect(() => toUsageEvent({ ...base, tokensIn: -1 })).toThrow(
      InvalidUsageEventError,
    );
    expect(() =>
      toUsageEvent({ ...base, tokensOut: MAX_USAGE_TOKENS + 1 }),
    ).toThrow(InvalidUsageEventError);
  });

  it("rejects a non-finite or absurd cost", () => {
    expect(() => toUsageEvent({ ...base, costUsd: Number.NaN })).toThrow(
      InvalidUsageEventError,
    );
    expect(() => toUsageEvent({ ...base, costUsd: Infinity })).toThrow(
      InvalidUsageEventError,
    );
    expect(() =>
      toUsageEvent({ ...base, costUsd: MAX_USAGE_COST_USD + 1 }),
    ).toThrow(InvalidUsageEventError);
  });

  it("rejects an empty runId, taskType or model", () => {
    expect(() => toUsageEvent({ ...base, runId: "   " })).toThrow(
      InvalidUsageEventError,
    );
    expect(() => toUsageEvent({ ...base, taskType: "" })).toThrow(
      InvalidUsageEventError,
    );
    expect(() => toUsageEvent({ ...base, model: "" })).toThrow(
      InvalidUsageEventError,
    );
  });

  it("rejects a non-ISO timestamp", () => {
    expect(() => toUsageEvent({ ...base, ts: "yesterday" })).toThrow(
      InvalidUsageEventError,
    );
  });

  it("rejects a pbiId that is not a positive safe integer", () => {
    expect(() => toUsageEvent({ ...base, pbiId: 0 })).toThrow(
      InvalidUsageEventError,
    );
    expect(() => toUsageEvent({ ...base, pbiId: 1.5 })).toThrow(
      InvalidUsageEventError,
    );
  });

  it("rejects an identifier carrying control characters or over-long text", () => {
    expect(() => toUsageEvent({ ...base, runId: "run\u0000-1" })).toThrow(
      InvalidUsageEventError,
    );
    expect(() => toUsageEvent({ ...base, taskType: "a\u007fb" })).toThrow(
      InvalidUsageEventError,
    );
    expect(() => toUsageEvent({ ...base, model: "m".repeat(257) })).toThrow(
      InvalidUsageEventError,
    );
  });
});