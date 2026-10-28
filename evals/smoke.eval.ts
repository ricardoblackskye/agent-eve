import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { evaluateSmokeReply } from "./helpers/smoke-reply";

export default defineEval({
  description: "Basic smoke test: agent boots and responds to a greeting.",
  async test(t) {
    const turn = await t.send("Hello! What can you help me with?");
    t.succeeded();

    // Asserts what the greeting check means - a reply that says what the agent can help with -
    // rather than the literal word "you" (#444).
    // eve 0.64: the reply lives on the returned turn now - `t.send` resolves to the turn and
    // `t.reply` was removed. `evaluateSmokeReply` already takes `unknown`, so an absent message
    // stays a clean failed verdict rather than a throw.
    const { ok, message } = evaluateSmokeReply(turn.message);
    t.check(
      ok,
      satisfies((value: boolean) => value === true, message),
    );
  },
});
