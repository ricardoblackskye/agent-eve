import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { evaluateModelCheck } from "./helpers/model-check";

export default defineEval({
  description:
    "Verifies the agent uses the configured OpenRouter model (deepseek by default), or reports that its model is governed and so not readable from /eve/v1/info (#440).",
  tags: ["production"],
  async test(t) {
    const infoResponse = await t.target.fetch("/eve/v1/info");
    const info = await infoResponse.json();

    // The verdict carries the reason: a governed agent has no static id to compare, and the
    // message says so rather than reporting a pass that looks like it verified the model.
    const { ok, message } = evaluateModelCheck(info);
    t.check(
      ok,
      satisfies((value: boolean) => value === true, message),
    );
  },
});
