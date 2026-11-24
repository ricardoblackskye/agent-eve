// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunTable } from "../../app/dark-factory/ui/components";
import type { TableRow } from "../../app/dark-factory/ui/view-model";

/**
 * #748 task 2, the behavioural half of the guard.
 *
 * The wiring assertions in run-table-adoption.test.ts prove the names exist; they could not tell a working
 * table from a broken one, and during this task they passed while the code was wrong three ways. These cases
 * pin what the adoption is FOR: the server owns the order and the filtering, so the table must render what
 * it was handed, in the order it was handed, without a client row model having an opinion.
 */
function row(runId: string, stage: string): TableRow {
  return {
    runId,
    issueLabel: `#${runId}`,
    repo: "owner/repo",
    status: "succeeded",
    category: "completed",
    stage,
    updatedLabel: "1h ago",
    updatedAtLabel: "01 Nov 2026, 14:32",
    attemptCount: 1,
    elapsedLabel: "2m",
    costLabel: "$0.01",
  };
}

// Deliberately NOT sorted by run id, and NOT all in the stage a client filter would keep.
const ROWS: TableRow[] = [row("df-c", "terminal"), row("df-a", "review"), row("df-b", "terminal")];

function renderedIds(html: HTMLElement): string[] {
  return [...html.querySelectorAll("tbody tr")].map((tr) => tr.textContent ?? "");
}

describe("#748 the table renders what the server decided", () => {
  it("keeps the order it was handed, so no client row model re-sorts it", () => {
    const { container } = render(<RunTable rows={ROWS} />);
    const text = renderedIds(container);
    expect(text).toHaveLength(3);
    expect(text[0]).toContain("df-c");
    expect(text[1]).toContain("df-a");
    expect(text[2]).toContain("df-b");
  });

  it("renders every row it was handed, so no client row model filters it", () => {
    const { container } = render(<RunTable rows={ROWS} />);
    for (const run of ROWS) {
      expect(container.textContent).toContain(run.runId);
    }
  });

  it("renders the date and time field on the row, not only in the model", () => {
    const { container } = render(<RunTable rows={ROWS} />);
    expect(container.textContent).toContain("01 Nov 2026, 14:32");
  });
});
