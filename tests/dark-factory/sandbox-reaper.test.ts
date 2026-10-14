import { describe, expect, it, vi } from "vitest";
import {
  reapSandboxesByRun,
  type SandboxManagerLike,
} from "../../agent/lib/dark-factory/sandbox-reaper";

function fakeManager() {
  const deleted: string[] = [];
  const listCalls: Array<{
    metadata?: Record<string, string>;
    states?: string[];
  }> = [];
  const manager: SandboxManagerLike = {
    listSandboxInfos: vi.fn(async (filter) => {
      listCalls.push({ metadata: filter?.metadata, states: filter?.states });
      return {
        items: [{ id: "sb-keep-1" }, { id: "sb-keep-2" }],
      };
    }),
    killSandbox: vi.fn(async (id: string) => {
      deleted.push(id);
    }),
  };
  return { manager, deleted, listCalls };
}

describe("reapSandboxesByRun", () => {
  it("lists by the run metadata and deletes every matching sandbox", async () => {
    const { manager, deleted, listCalls } = fakeManager();
    const ids = await reapSandboxesByRun({ runId: "run-7", manager });
    expect(listCalls[0]?.metadata).toEqual({ run: "run-7" });
    expect(ids).toEqual(["sb-keep-1", "sb-keep-2"]);
    expect(deleted).toEqual(["sb-keep-1", "sb-keep-2"]);
  });

  it("forwards an optional states filter", async () => {
    const { manager, listCalls } = fakeManager();
    await reapSandboxesByRun({ runId: "run-7", states: ["Running"], manager });
    expect(listCalls[0]?.states).toEqual(["Running"]);
  });

  it("swallows delete failures so a stuck orphan cannot abort the run", async () => {
    const throwing: SandboxManagerLike = {
      listSandboxInfos: vi.fn(async () => ({ items: [{ id: "sb-x" }] })),
      killSandbox: vi.fn(async () => {
        throw new Error("stuck");
      }),
    };
    await expect(
      reapSandboxesByRun({ runId: "r", manager: throwing }),
    ).resolves.toEqual(["sb-x"]);
  });
});
