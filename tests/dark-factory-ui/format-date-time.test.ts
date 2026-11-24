import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../app/dark-factory/ui/format";

describe("run date and time field (#748 task 3)", () => {
  it("reads as one field: day, month, year, then the time", () => {
    // Built from LOCAL components on purpose. The formatter must render the viewer's own
    // timezone, so this expectation holds wherever the suite runs - no TZ pinning, no flake.
    expect(formatDateTime(new Date(2026, 10, 1, 14, 32))).toBe("01 Nov 2026, 14:32");
  });

  it("pads the day, the hour and the minute", () => {
    expect(formatDateTime(new Date(2026, 0, 5, 9, 4))).toBe("05 Jan 2026, 09:04");
  });

  it("renders an ISO instant in the viewer's zone, not in UTC", () => {
    const iso = "2026-11-01T14:32:00.000Z";
    const local = new Date(iso);
    const expected =
      String(local.getDate()).padStart(2, "0") +
      " " +
      ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][local.getMonth()] +
      " " +
      local.getFullYear() +
      ", " +
      String(local.getHours()).padStart(2, "0") +
      ":" +
      String(local.getMinutes()).padStart(2, "0");
    expect(formatDateTime(iso)).toBe(expected);
  });

  it("takes a date, a timestamp or an ISO string alike", () => {
    const at = new Date(2026, 10, 1, 14, 32);
    expect(formatDateTime(at)).toBe(formatDateTime(at.getTime()));
    expect(formatDateTime(at.getTime())).toBe(formatDateTime("2026-11-01T14:32:00.000Z"));
  });
});
