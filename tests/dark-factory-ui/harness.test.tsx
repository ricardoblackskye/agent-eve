// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("component-test harness", () => {
  it("renders React into a jsdom document", () => {
    const { container } = render(<div id="df-smoke">ok</div>);
    expect(container.querySelector("#df-smoke")?.textContent).toBe("ok");
  });
});
