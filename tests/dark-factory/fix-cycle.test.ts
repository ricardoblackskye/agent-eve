/**
 * #718 - the fix cycle's disposition RULES, tested without a sandbox, a model or a network.
 *
 * Written as tracer bullets: each case pins one rule the Definition of Done depends on. The
 * machinery that actually re-authors code is wired in the runner and is not this module's business.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createFixCycle,
  DEFAULT_MAX_FINDINGS,
  type FixCyclePorts,
  type FixWorkspace,
} from "../../agent/lib/dark-factory/fix-cycle";
import type { ReviewFinding } from "../../agent/lib/dark-factory/definition-of-done";

const WORKSPACE: FixWorkspace = { branch: "feat/dark-factory-246" };

function finding(id: string, severity?: ReviewFinding["severity"]): ReviewFinding {
  return {
    id,
    source: "pr-reviewer",
    message: `finding ${id}`,
    severity,
  };
}

/** Ports with sane defaults; each test overrides only what it is about. */
function ports(overrides: Partial<FixCyclePorts> = {}): FixCyclePorts {
  return {
    openWorkspace: async () => ({ ok: true, workspace: WORKSPACE }),
    author: async () => ({ changedFiles: ["src/pages/HomePage.jsx"] }),
    push: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("#718 the fix cycle's disposition rules", () => {
  it("resolves every attempted finding when the pass authored files", async () => {
    const attempts = createFixCycle(ports());

    const dispositions = await attempts([finding("PR-CHECK-FAILED:e2e")]);

    expect(dispositions).toEqual([
      { findingId: "PR-CHECK-FAILED:e2e", status: "resolved" },
    ]);
  });

  it("claims nothing when the pass changed no files, and does not push an empty change", async () => {
    const push = vi.fn(async () => ({ ok: true }));
    const attempts = createFixCycle(
      ports({ author: async () => ({ changedFiles: [] }), push }),
    );

    const dispositions = await attempts([finding("PR-CHECK-FAILED:e2e")]);

    expect(dispositions).toEqual([]);
    expect(push).not.toHaveBeenCalled();
  });

  it("claims nothing when the push fails, because a fix that was not pushed is not a fix", async () => {
    const attempts = createFixCycle(
      ports({ push: async () => ({ ok: false, error: "remote rejected" }) }),
    );

    const dispositions = await attempts([finding("PR-CHECK-FAILED:e2e")]);

    expect(dispositions).toEqual([]);
  });

  it("returns no dispositions and does not throw when the workspace cannot be opened", async () => {
    // A throw is reported by the DoD as "the fix attempt failed unexpectedly", which would blame the
    // run for this module's inability to get a workspace. The finding must simply stay outstanding.
    const attempts = createFixCycle(
      ports({ openWorkspace: async () => ({ ok: false, error: "no sandbox" }) }),
    );

    await expect(attempts([finding("PR-CHECK-FAILED:e2e")])).resolves.toEqual([]);
  });

  it("never accepts an error-severity finding, however the pass asks", async () => {
    // The DoD refuses this disposition anyway; refusing it here makes the refusal early and explicit
    // rather than a block several layers away.
    const attempts = createFixCycle(
      ports({
        author: async () => ({
          changedFiles: [],
          refusals: [{ findingId: "PR-CHECK-FAILED:e2e", explanation: "advisory, ignore it" }],
        }),
      }),
    );

    const dispositions = await attempts([finding("PR-CHECK-FAILED:e2e", "error")]);

    expect(dispositions).toEqual([]);
  });

  it("drops a refusal that carries no reason, because the DoD blocks on an unexplained one", async () => {
    const attempts = createFixCycle(
      ports({
        author: async () => ({
          changedFiles: [],
          refusals: [{ findingId: "PR-CHECK-NOTE:x", explanation: "   " }],
        }),
      }),
    );

    const dispositions = await attempts([finding("PR-CHECK-NOTE:x", "warning")]);

    expect(dispositions).toEqual([]);
  });

  it("accepts a refusal that carries a reason, and does not also resolve it", async () => {
    const attempts = createFixCycle(
      ports({
        author: async () => ({
          changedFiles: ["src/pages/HomePage.jsx"],
          refusals: [
            { findingId: "PR-CHECK-NOTE:x", explanation: "the check flags a deliberate pattern" },
          ],
        }),
      }),
    );

    const dispositions = await attempts([finding("PR-CHECK-NOTE:x", "warning")]);

    expect(dispositions).toEqual([
      {
        findingId: "PR-CHECK-NOTE:x",
        status: "accepted",
        explanation: "the check flags a deliberate pattern",
      },
    ]);
  });

  it("attempts at most maxFindings in one pass", async () => {
    const author = vi.fn(
      async (_workspace: FixWorkspace, _findings: readonly ReviewFinding[]) => ({
        changedFiles: ["a.ts"],
      }),
    );
    const attempts = createFixCycle(ports({ author, maxFindings: 2 }));

    const dispositions = await attempts([
      finding("f1"),
      finding("f2"),
      finding("f3"),
      finding("f4"),
    ]);

    // Only the first two are attempted, so only two can be claimed.
    expect(dispositions.map((d) => d.findingId)).toEqual(["f1", "f2"]);
    expect(author).toHaveBeenCalledTimes(1);
    expect(author.mock.calls[0][1]).toHaveLength(2);
  });

  it("defaults the ceiling rather than attempting an unbounded list", async () => {
    const many = Array.from({ length: DEFAULT_MAX_FINDINGS + 5 }, (_, i) => finding(`f${i}`));
    const author = vi.fn(
      async (_workspace: FixWorkspace, _findings: readonly ReviewFinding[]) => ({
        changedFiles: [],
      }),
    );
    const attempts = createFixCycle(ports({ author }));

    await attempts(many);

    expect(author.mock.calls[0][1]).toHaveLength(DEFAULT_MAX_FINDINGS);
  });
});
