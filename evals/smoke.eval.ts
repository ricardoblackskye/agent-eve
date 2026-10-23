import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { evaluateSmokeReply } from "./helpers/smoke-reply";

export default defineEval({
  description: "Basic smoke test: agent boots and responds to a greeting.",
  async test(t) {
    await t.send("Hello! What can you help me with?");
    t.succeeded();

    // Asserts what the greeting check means - a reply that says what the agent can help with -
    // rather than the literal word "you" (#444).
    const { ok, message } = evaluateSmokeReply(t.reply);
    t.check(
      ok,
      satisfies((value: boolean) => value === true, message),
    );
  },
});
