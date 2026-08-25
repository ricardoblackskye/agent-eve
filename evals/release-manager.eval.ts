import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description: "Verifies the Release Manager subagent is available.",
  tags: ["production"],
  async test(t) {
    const infoResponse = await t.target.fetch("/eve/v1/info");
    const info = await infoResponse.json();

    // Check that the info endpoint lists the release-manager subagent
    const hasReleaseManager =
      JSON.stringify(info).includes("release-manager") ||
      info?.capabilities?.subagents?.some?.(
        (s: { name?: string }) => s.name === "release-manager",
      );

    t.check(
      hasReleaseManager,
      satisfies(
        (flag: boolean) => flag === true,
        "release-manager subagent is registered",
      ),
    );
  },
});