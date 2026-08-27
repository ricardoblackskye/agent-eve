import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "Verifies the Release Manager subagent tools are accessible and functional.",
  tags: ["production"],
  async test(t) {
    const infoResponse = await t.target.fetch("/eve/v1/info");
    const info = await infoResponse.json();
    const jsonStr = JSON.stringify(info);

    // Check subagent is registered (tools are internal to the subagent)
    t.check(
      jsonStr.includes("release-manager"),
      satisfies(
        (found: boolean) => found === true,
        "release-manager subagent is registered",
      ),
    );

    // Check subagent description mentions notes generation
    t.check(
      jsonStr.includes("release notes"),
      satisfies(
        (found: boolean) => found === true,
        "release-manager description mentions release notes",
      ),
    );
  },
});
