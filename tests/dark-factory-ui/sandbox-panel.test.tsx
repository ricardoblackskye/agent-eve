// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxViewPanel } from "../../app/dark-factory/ui/sandbox-panel";

/**
 * #790 R1 (#791) - the sandbox view panel (task 5).
 *
 * The panel is the browser half of a decision the SERVER makes, so the cases below are mostly about what it does NOT
 * render. Three properties:
 *
 *   AC1/AC3 - a panel renders only when the server reports a view. A `not-local` answer (the deployed case) renders
 *             nothing at all - not a disabled panel, not a link with an explanation.
 *   AC2     - everything the panel offers is a read: no input, no textarea, no form.
 *   AC5     - once a view has been live and the server then reports it gone, the panel says the view has ended
 *             instead of silently disappearing or waiting forever.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const LIVE = {
  available: true,
  sandboxId: "sb-1",
  workspace: "/workspace",
  entries: [
    { path: "src/App.tsx", type: "file", name: "App.tsx" },
    { path: "src/index.ts", type: "file", name: "index.ts" },
  ],
};

const FILE = {
  available: true,
  sandboxId: "sb-1",
  workspace: "/workspace",
  entries: [],
  file: { path: "src/App.tsx", content: "export const a = 1;", truncated: false },
};

/** One stub whose LISTING answer the test can swap mid-run, so the transition to "ended" is testable. */
function stub(sandboxView: () => unknown) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("file=")) return jsonResponse(FILE);
      return jsonResponse(sandboxView());
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#790 R1 sandbox view panel", () => {
  it("renders nothing at all when the server says the view is not local", async () => {
    const { calls } = stub(() => ({
      available: false,
      reason: "not-local",
      message: "This run's sandbox is reached at sandbox.example.com:443, which is not this machine.",
    }));

    const { container } = render(<SandboxViewPanel runId="run-1" />);

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(container.textContent).toBe("");
  });

  it("lists the workspace the server reports, with no write control anywhere in it", async () => {
    stub(() => LIVE);

    const { container } = render(<SandboxViewPanel runId="run-1" />);

    await screen.findByText("src/App.tsx");
    expect(screen.getByText("src/index.ts")).toBeTruthy();
    expect(container.querySelectorAll("input, textarea, form")).toHaveLength(0);
  });

  it("shows one file's contents when the operator selects it", async () => {
    stub(() => LIVE);

    render(<SandboxViewPanel runId="run-1" />);
    fireEvent.click(await screen.findByText("src/App.tsx"));

    await screen.findByText(/export const a = 1;/);
  });

  it("says the view has ended when a view that was live is then reported gone", async () => {
    let answer: unknown = LIVE;
    stub(() => answer);

    render(<SandboxViewPanel runId="run-1" />);
    await screen.findByText("src/App.tsx");

    // The run finished: the sandbox is gone, and the endpoint says so.
    answer = {
      available: false,
      reason: "no-live-sandbox",
      message: "No local sandbox is running for this run any more: the view has ended.",
    };
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await screen.findByText(/the view has ended/i);
    // The listing is gone with it: the panel is not showing a stale tree beside a notice.
    expect(screen.queryByText("src/App.tsx")).toBeNull();
  });

  it("CONTROL: the same panel with a live view is not empty, so the not-local case is not vacuous", async () => {
    stub(() => LIVE);

    const { container } = render(<SandboxViewPanel runId="run-1" />);

    await screen.findByText("src/App.tsx");
    expect(container.textContent).not.toBe("");
  });
});
