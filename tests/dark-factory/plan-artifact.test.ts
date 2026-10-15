import { describe, expect, it } from "vitest";
import {
  filesToCommitFromRun,
  planFilePath,
  pullRequestBody,
} from "../../scripts/dark-factory-runner";

/**
 * #361 Task 10 — the rendered plan must be written into the run's commit, and linked from the pull
 * request so a reviewer can see the intent without leaving GitHub.
 */
describe("the plan artifact (#361 Task 10)", () => {
  it("commits the plan to a per-issue path under .hermes/plans", () => {
    expect(planFilePath(361)).toBe(".hermes/plans/df-361.md");
  });

  it("includes the plan file in the set of files to commit", () => {
    const authored = { written: ["app/chat.tsx"] };
    const plan = { targetFiles: [{ path: "app/chat.tsx" }] };
    const files = filesToCommitFromRun(authored, plan, [".hermes/plans/df-361.md"]);
    expect(files).toContain(".hermes/plans/df-361.md");
    expect(files).toContain("app/chat.tsx");
  });

  it("still de-duplicates when the extra path is already present", () => {
    const plan = { targetFiles: [{ path: ".hermes/plans/df-361.md" }] };
    const files = filesToCommitFromRun(undefined, plan, [".hermes/plans/df-361.md"]);
    expect(files).toEqual([".hermes/plans/df-361.md"]);
  });

  it("keeps the closing keyword in the pull request body", () => {
    const body = pullRequestBody({ issueNum: 361 });
    expect(body).toContain("Closes #361");
    expect(body).toContain("Eve's Developer Agent");
  });

  it("links the plan from the pull request body when it is known", () => {
    const body = pullRequestBody({
      issueNum: 361,
      planPath: ".hermes/plans/df-361.md",
      repo: "ricardoblackskye/agent-eve",
      branch: "df-run-361",
    });
    // A bare relative link would resolve against the PR page, so the link must be an absolute blob URL.
    expect(body).toContain(
      "https://github.com/ricardoblackskye/agent-eve/blob/df-run-361/.hermes/plans/df-361.md",
    );
  });

  it("omits the link rather than emitting a broken one when the plan is unknown", () => {
    const body = pullRequestBody({ issueNum: 361, repo: "o/r", branch: "b" });
    expect(body).not.toContain("blob");
  });
});
