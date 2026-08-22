import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Basic smoke test: agent boots and responds to a greeting.",
  async test(t) {
    await t.send("Hello! What can you help me with?");
    t.succeeded();
    t.check(t.reply, includes("you"));
  },
});