// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ControlPanel } from "../../app/dark-factory/ui/control-panel";

const now = "2026-09-29T10:00:00.000Z";
const factory = { paused: false, updatedAt: now, actor: "operator@example.test" };

describe("ControlPanel", () => {
  it("renders factory status and the action that changes it", () => {
    const onAction = vi.fn();
    render(<ControlPanel loading={false} error={null} unauthenticated={false} pending={false} factory={factory} onAction={onAction} />);
    expect(screen.getByText("Factory running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause factory" }));
    expect(onAction).toHaveBeenCalledWith("pause", "factory");
  });

  it("shows resumable pause and a terminal Stop action for a run", () => {
    const onAction = vi.fn();
    render(<ControlPanel loading={false} error={null} unauthenticated={false} pending={false} factory={factory} runId="run-42" run={{ paused: true, stopped: false, updatedAt: now }} onAction={onAction} />);
    expect(screen.getByText("Run paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume run" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
    expect(onAction).toHaveBeenNthCalledWith(1, "resume", "run");
    expect(onAction).toHaveBeenNthCalledWith(2, "stop", "run");
  });

  it("withholds controls when the viewer is unauthenticated", () => {
    render(<ControlPanel loading={false} error={null} unauthenticated factory={factory} pending={false} onAction={vi.fn()} />);
    expect(screen.getByText("Sign in to control the factory")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
