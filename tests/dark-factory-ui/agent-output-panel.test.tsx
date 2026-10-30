// @vitest-environment jsdom
/**
 * #561 — the run detail page shows what the recorder captured.
 *
 * The panel is read-only and lists only events that CARRY a captured summary. The middle case is
 * the control that keeps it honest: an event with no summary must not appear, or a panel that
 * rendered every event would satisfy the others.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentOutputPanel } from "../../app/dark-factory/ui/components";
import type { PersistedRunEvent } from "../../agent/lib/dark-factory/run-history-store";

const AT = "2026-10-30T12:34:56.000Z";

function captured(summary: string, sequence = 1): PersistedRunEvent {
  return {
    sequence,
    event: {
      eventId: `evt-${sequence}`,
      runId: "run-561",
      type: "worker.roadblock",
      stage: "worker",
      occurredAt: AT,
      status: "running",
      agentOutputSummary: summary,
    },
  } as PersistedRunEvent;
}

function notCaptured(sequence = 2): PersistedRunEvent {
  return {
    sequence,
    event: {
      eventId: `evt-${sequence}`,
      runId: "run-561",
      type: "worker.progress",
      stage: "worker",
      occurredAt: AT,
      status: "running",
    },
  } as PersistedRunEvent;
}

function capturedWithComment(summary: string): PersistedRunEvent {
  return {
    sequence: 3,
    event: {
      eventId: "evt-3",
      runId: "run-561",
      type: "worker.roadblock",
      stage: "worker",
      occurredAt: AT,
      status: "running",
      agentOutputSummary: summary,
      commentReference: {
        provider: "github",
        id: 2,
        url: "https://github.com/example/repo/issues/1#issuecomment-2",
      },
    },
  } as PersistedRunEvent;
}

describe("AgentOutputPanel (#561)", () => {
  it("renders a captured summary with its type and timestamp", () => {
    const { container } = render(
      <AgentOutputPanel events={[captured("the checkout is not provisioned")]} />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("the checkout is not provisioned");
    expect(text).toMatch(/roadblock/i);
    // Rendered as stored rather than locale-formatted, so the assertion is stable everywhere.
    expect(text).toContain("2026-10-30");
  });

  it("CONTROL: does not list an event that carries no captured summary", () => {
    const { container } = render(
      <AgentOutputPanel events={[captured("only this one"), notCaptured()]} />,
    );

    const rows = container.querySelectorAll(".df-agent-output-row");
    expect(rows.length).toBe(1);
    expect(container.textContent).toContain("only this one");
  });

  it("CONTROL: renders the empty state when nothing was captured", () => {
    const { container } = render(<AgentOutputPanel events={[notCaptured()]} />);

    expect(container.querySelector(".df-state-empty")).not.toBeNull();
    expect(container.querySelector(".df-state-error")).toBeNull();
    expect(container.querySelectorAll(".df-agent-output-row").length).toBe(0);
  });

  it("links the posted issue comment when the recorder stored a reference", () => {
    const { container } = render(
      <AgentOutputPanel events={[capturedWithComment("see the ticket")]} />,
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "https://github.com/example/repo/issues/1#issuecomment-2",
    );
  });

  it("CONTROL: renders no link when no reference was stored", () => {
    // Paired with the case above, so a link rendered unconditionally cannot pass.
    const { container } = render(
      <AgentOutputPanel events={[captured("no ticket link")]} />,
    );

    expect(container.querySelector("a")).toBeNull();
  });
});
