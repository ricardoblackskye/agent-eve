import { describe, it, expect } from "vitest";
import {
  isTransientModelError,
  parseRetryAfter,
  retryDelayMs,
  RETRY_DEFAULTS,
} from "../scripts/pr-reviewer-retry";

// #191: a transient OpenRouter failure (429 / 5xx / network / empty 200) must
// be retried, not turned straight into the structural fallback.
describe("isTransientModelError (#191)", () => {
  it("treats HTTP 429 as transient", () => {
    expect(isTransientModelError({ status: 429 })).toBe(true);
  });

  it("treats 5xx as transient", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isTransientModelError({ status })).toBe(true);
    }
  });

  it("treats a network/transport error (no status) as transient", () => {
    expect(isTransientModelError({ status: null })).toBe(true);
    expect(isTransientModelError({})).toBe(true);
  });

  it("treats an empty 200 as transient", () => {
    expect(isTransientModelError({ status: 200, emptyContent: true })).toBe(
      true,
    );
  });

  it("does NOT treat a good 200 as a failure", () => {
    expect(isTransientModelError({ status: 200 })).toBe(false);
    expect(isTransientModelError({ status: 200, emptyContent: false })).toBe(
      false,
    );
  });

  it("does NOT retry client config errors (400/401/403/404)", () => {
    for (const status of [400, 401, 403, 404]) {
      expect(isTransientModelError({ status })).toBe(false);
    }
  });
});

describe("parseRetryAfter (#191)", () => {
  it("parses integer seconds to ms", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("returns null for missing or invalid values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("-5")).toBeNull();
  });

  it("parses an HTTP-date relative to now", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    const when = new Date(now + 10000).toUTCString();
    expect(parseRetryAfter(when, now)).toBe(10000);
  });
});

describe("retryDelayMs (#191)", () => {
  const noJitter = () => 0;

  it("grows exponentially from the base", () => {
    expect(retryDelayMs(1, { random: noJitter })).toBe(RETRY_DEFAULTS.baseMs);
    expect(retryDelayMs(2, { random: noJitter })).toBe(
      RETRY_DEFAULTS.baseMs * 2,
    );
    expect(retryDelayMs(3, { random: noJitter })).toBe(
      RETRY_DEFAULTS.baseMs * 4,
    );
  });

  it("caps the delay", () => {
    expect(retryDelayMs(10, { random: noJitter })).toBe(RETRY_DEFAULTS.capMs);
  });

  it("adds up to one base of jitter", () => {
    expect(retryDelayMs(1, { baseMs: 2000, random: () => 0.5 })).toBe(3000);
  });

  it("honours a server Retry-After but still caps it", () => {
    expect(retryDelayMs(1, { retryAfterMs: 5000, random: noJitter })).toBe(
      5000,
    );
    expect(retryDelayMs(1, { retryAfterMs: 600000, random: noJitter })).toBe(
      RETRY_DEFAULTS.capMs,
    );
  });

  it("never returns a negative delay", () => {
    expect(retryDelayMs(0, { random: noJitter })).toBeGreaterThanOrEqual(0);
    expect(
      retryDelayMs(-1, { retryAfterMs: -100, random: noJitter }),
    ).toBeGreaterThanOrEqual(0);
  });
});
