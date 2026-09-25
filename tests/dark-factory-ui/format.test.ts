import { describe, expect, it } from "vitest";
import {
  formatClockTime,
  formatCostUsd,
  formatCount,
  formatDuration,
  formatRelativeTime,
} from "../../app/dark-factory/ui/format";

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");

  it("shows 'now' under a minute", () => {
    expect(formatRelativeTime("2026-09-25T11:59:30.000Z", now)).toBe("now");
  });

  it("shows minutes", () => {
    expect(formatRelativeTime("2026-09-25T11:58:00.000Z", now)).toBe("2m");
  });

  it("shows hours", () => {
    expect(formatRelativeTime("2026-09-25T09:00:00.000Z", now)).toBe("3h");
  });

  it("shows days", () => {
    expect(formatRelativeTime("2026-09-24T12:00:00.000Z", now)).toBe("1d");
  });
});

describe("formatDuration", () => {
  it("formats minutes and seconds", () => {
    expect(
      formatDuration("2026-09-25T12:00:00.000Z", "2026-09-25T12:14:02.000Z"),
    ).toBe("14m 02s");
  });

  it("formats sub-minute durations in seconds", () => {
    expect(
      formatDuration("2026-09-25T12:00:00.000Z", "2026-09-25T12:00:42.000Z"),
    ).toBe("42s");
  });

  it("formats hours", () => {
    expect(
      formatDuration("2026-09-25T10:00:00.000Z", "2026-09-25T11:05:00.000Z"),
    ).toBe("1h 05m");
  });

  it("returns an em dash when either bound is absent", () => {
    expect(formatDuration(undefined, "2026-09-25T12:14:02.000Z")).toBe("—");
    expect(formatDuration("2026-09-25T12:00:00.000Z", undefined)).toBe("—");
    expect(formatDuration()).toBe("—");
  });
});

describe("formatCostUsd", () => {
  it("formats to cents", () => {
    expect(formatCostUsd(0.42)).toBe("$0.42");
  });

  it("returns an em dash for an absent measurement, never a zero", () => {
    expect(formatCostUsd(undefined)).toBe("—");
  });

  it("renders an explicit measured zero as $0.00", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
  });
});

describe("formatCount", () => {
  it("zero-pads to two digits", () => {
    expect(formatCount(7)).toBe("07");
    expect(formatCount(23)).toBe("23");
    expect(formatCount(100)).toBe("100");
  });
});

describe("formatClockTime", () => {
  it("renders UTC HH:MM:SS", () => {
    expect(formatClockTime("2026-09-25T09:14:01.000Z")).toBe("09:14:01");
  });
});
