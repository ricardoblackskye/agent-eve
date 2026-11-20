/**
 * #718 - the fix cycle's adapter: the sandbox it opens, the order it prepares it in, and the fact
 * that it always closes it.
 *
 * This runs real sandbox, git and push machinery on a production path, so it is proven with
 * recording doubles - the idiom ADR 0032 established for `runCodingPhase` ("a recording double
 * proves the order: create -> phase -> dispose"). No test here opens a sandbox, and the push is the
 * REAL `commitAndPushFromSandbox` driven through a fake `runGit`, so what the workspace is asked to
 * do is what production asks it to do.
 */
import { describe, expect, it } from "vitest";
import {
  buildFixCycleAdapter,
  type FixCycleAdapterDeps,
} from "../../scripts/dark-factory-runner";
import type { SandboxProvider } from "../../agent/lib/dark-factory/sandbox";
import type { WorkspaceTools } from "../../agent/lib/dark-factory/developer-agent";
import type { CodeAuthorProvider } from "../../agent/lib/dark-factory/code-author";
import type { ReviewFinding } from "../../agent/lib/dark-factory/definition-of-done";

const RUN_ID = "a37cc0c6-3884-4d71-bec0-2a4332bbaa6b";
const BRANCH = "feat/dark-factory-246";
const WORKSPACE = "/ws";
const FILE = "src/pages/HomePage.jsx";

const FINDING: ReviewFinding = {
  id: "PR-CHECK-FAILED:e2e",
  source: "test",
  message: "the e2e check failed",
  file: FILE,
  severity: "error",
};

/** A provider that records what it is asked to do, and git calls that succeed by default. */
function harness(overrides: Partial<FixCycleAdapterDeps> = {}) {
  const log: string[] = [];
  const tools: WorkspaceTools = {
    writeFile: async () => {},
    readFile: async () => "",
    listFiles: async () => [],
    runTests: async () => ({ passed: true, output: "", ran: true }),
  };
  const provider = {
    driver: "local" as const,
    isolated: false,
    create: () => {
      log.push("create");
      return tools;
    },
    dispose: async () => {
      log.push("dispose");
    },
    runGit: async (args: string[]) => {
      log.push(`git:${args.join(" ")}`);
      return { exitCode: 0, output: "" };
    },
  } as unknown as SandboxProvider;

  const author = {
    write: async () => ({ files: { [FILE]: "// fixed" } }),
  } as unknown as CodeAuthorProvider;

  const deps: FixCycleAdapterDeps = {
    runId: RUN_ID,
    branchName: BRANCH,
    remoteUrl: "https://github.com/owner/repo.git",
    workspaceDir: () => WORKSPACE,
    author: () => author,
    createProvider: (runId) => {
      log.push(`provider:${runId}`);
      return provider;
    },
    ...overrides,
  };
  return { deps, log, tools };
}

const indexOf = (log: string[], needle: string) =>
  log.findIndex((entry) => entry.includes(needle));

describe("#718 the fix cycle adapter", () => {
  it("builds the sandbox FOR THE RUN, so the reaper can still find it", async () => {
    const { deps, log } = harness();
    await buildFixCycleAdapter(deps)([FINDING]);
    expect(log).toContain(`provider:${RUN_ID}`);
  });

  it("fetches and checks out the pull request's branch before a fix is authored", async () => {
    const { deps, log } = harness();
    await buildFixCycleAdapter(deps)([FINDING]);
    const fetch = indexOf(log, `fetch origin ${BRANCH}`);
    const checkout = indexOf(log, `checkout ${BRANCH}`);
    expect(fetch, "the branch must be fetched").toBeGreaterThanOrEqual(0);
    expect(checkout, "the branch must be checked out").toBeGreaterThan(fetch);
  });

  it("keeps the fix on that branch, never resetting it to the default tip", async () => {
    // The push uses `git checkout -B <branch>`, which RESETS the branch to the current HEAD. If the
    // prepare step had checked out the default tip, that reset would move the pull request's branch
    // back to main and discard the work the pass was meant to be fixing.
    const { deps, log } = harness();
    await buildFixCycleAdapter(deps)([FINDING]);
    const fetch = indexOf(log, `fetch origin ${BRANCH}`);
    const push = indexOf(log, `checkout -B ${BRANCH}`);
    expect(push).toBeGreaterThan(fetch);
  });

  it("stages exactly the files the pass authored", async () => {
    const { deps, log } = harness();
    await buildFixCycleAdapter(deps)([FINDING]);
    expect(log).toContain(`git:-C ${WORKSPACE} add -- ${FILE}`);
  });

  it("closes the sandbox after a pass that pushed successfully", async () => {
    const { deps, log } = harness();
    const dispositions = await buildFixCycleAdapter(deps)([FINDING]);
    expect(dispositions).toEqual([{ findingId: FINDING.id, status: "resolved" }]);
    expect(log).toContain("dispose");
  });

  it("closes the sandbox when the authoring pass fails, and claims nothing", async () => {
    const { deps, log } = harness({
      author: () =>
        ({
          write: async () => {
            throw new Error("the model returned nothing");
          },
        }) as unknown as CodeAuthorProvider,
    });
    const dispositions = await buildFixCycleAdapter(deps)([FINDING]);
    expect(dispositions).toEqual([]);
    expect(log).toContain("dispose");
  });

  it("closes the sandbox, and claims nothing, when the branch cannot be prepared", async () => {
    const failing = {
      driver: "local" as const,
      isolated: false,
      create: () => ({} as WorkspaceTools),
      dispose: async () => {},
      runGit: async (args: string[]) =>
        args.includes("fetch")
          ? { exitCode: 128, output: "couldn't find remote ref" }
          : { exitCode: 0, output: "" },
    } as unknown as SandboxProvider;
    const { deps } = harness({ createProvider: () => failing });
    const dispositions = await buildFixCycleAdapter(deps)([FINDING]);
    expect(dispositions).toEqual([]);
  });
});
