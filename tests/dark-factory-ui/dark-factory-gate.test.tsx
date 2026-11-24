// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { resolveViewer } = vi.hoisted(() => ({ resolveViewer: vi.fn() }));
vi.mock("../../app/api/dark-factory/viewer", () => ({ resolveViewer }));

import DarkFactoryLayout from "../../app/dark-factory/layout";

const board = <div>board content</div>;

async function renderLayout() {
  const ui = await DarkFactoryLayout({ children: board });
  return render(ui);
}

describe("the dark factory is operator-gated (#748 task 6)", () => {
  it("renders the board for an active operator", async () => {
    resolveViewer.mockResolvedValue({
      ok: true,
      viewer: { email: "ops@example.test", role: "operator" },
    });
    const { container } = await renderLayout();
    expect(container.textContent).toContain("board content");
  });

  it("refuses a viewer with no membership", async () => {
    resolveViewer.mockResolvedValue({ ok: false, status: 403, error: "no membership" });
    const { container } = await renderLayout();
    expect(container.textContent).not.toContain("board content");
    expect(container.textContent).toMatch(/operator|not available|refused/i);
  });

  it("refuses a customer, who is scoped to their own tenant", async () => {
    resolveViewer.mockResolvedValue({
      ok: true,
      viewer: { email: "customer@example.test", role: "customer", tenantId: "t-1" },
    });
    const { container } = await renderLayout();
    expect(container.textContent).not.toContain("board content");
  });

  it("refuses before rendering any navigation that would lead to a refusal", async () => {
    resolveViewer.mockResolvedValue({ ok: false, status: 401, error: "no session" });
    const { container } = await renderLayout();
    expect(container.querySelectorAll("a[href^='/dark-factory']")).toHaveLength(0);
  });
});
