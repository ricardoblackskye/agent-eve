import { describe, expect, it } from "vitest";
import { filesToCommitFromRun } from "../../scripts/dark-factory-runner";

/**
 * #361 (R2) — commit what the loop actually wrote, not only what the plan declared.
 *
 * In the #361 incident an authored test file that the plan's `targetFiles` never listed was never
 * staged, because the runner committed only `executionPlan.targetFiles`. The union of what the author
 * wrote and what the plan declared is the honest artifact to stage.
 */
describe("filesToCommitFromRun", () => {
  const plan = {
    targetFiles: [{ path: "app/chat.tsx" }, { path: "app/chat.test.tsx" }],
  };

  it("falls back to the plan's targets when nothing was authored", () => {
    expect(filesToCommitFromRun(undefined, plan).sort()).toEqual(
      ["app/chat.test.tsx", "app/chat.tsx"].sort(),
    );
  });

  it("includes an authored file the plan never listed (the #361 loss case)", () => {
    const authored = { written: ["app/chat.tsx", "tests/chat-extra.test.ts"] };
    expect(filesToCommitFromRun(authored, plan).sort()).toEqual(
      ["app/chat.test.tsx", "app/chat.tsx", "tests/chat-extra.test.ts"].sort(),
    );
  });

  it("still commits the plan's targets even when the author skipped one (create-on-existing)", () => {
    // The author wrote only one of two targets; the other was a `create` that already existed and was
    // skipped. The plan's target still belongs in the commit.
    const authored = { written: ["app/chat.tsx"] };
    expect(filesToCommitFromRun(authored, plan).sort()).toEqual(
      ["app/chat.test.tsx", "app/chat.tsx"].sort(),
    );
  });

  it("dedupes a target that the author also wrote", () => {
    const authored = { written: ["app/chat.tsx"] };
    const result = filesToCommitFromRun(authored, {
      targetFiles: [{ path: "app/chat.tsx" }],
    });
    expect(result).toEqual(["app/chat.tsx"]);
  });
});
