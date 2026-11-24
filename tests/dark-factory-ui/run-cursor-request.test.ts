import { describe, expect, it } from "vitest";
import { buildCursorRequest, cursorBounds } from "../../app/dark-factory/ui/view-model";

describe("run list asks by cursor (#748 task 4)", () => {
  it("asks for a page size and no offset", () => {
    const params = buildCursorRequest({}, { size: 20 });
    expect(params.get("limit")).toBe("20");
    expect(params.get("offset")).toBeNull();
    expect(params.get("cursor")).toBeNull();
  });

  it("passes the cursor through untouched, because the client never reads it", () => {
    const params = buildCursorRequest({}, { size: 20, cursor: "b3BhcXVl.tok+en" });
    expect(params.get("cursor")).toBe("b3BhcXVl.tok+en");
    expect(params.get("offset")).toBeNull();
  });

  it("still carries the filters", () => {
    const params = buildCursorRequest({ statuses: ["failed"] }, { size: 50, cursor: "tok" });
    expect(params.getAll("status")).toEqual(["failed"]);
    expect(params.get("limit")).toBe("50");
  });

  it("decides the arrows from the stack position and the returned cursor", () => {
    expect(cursorBounds(1, null)).toEqual({ canGoBack: false, canGoForward: false });
    expect(cursorBounds(2, null)).toEqual({ canGoBack: true, canGoForward: false });
    expect(cursorBounds(1, "next")).toEqual({ canGoBack: false, canGoForward: true });
    expect(cursorBounds(3, "next")).toEqual({ canGoBack: true, canGoForward: true });
  });
});
