import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Basic smoke test: agent boots and responds to a greeting.",
  async test(t) {
    await t.send("Hello! What can you do?");
    t.succeeded();
    t.check(t.reply, includes("assist"));
    t.check(t.reply, includes("tools"));
  },
});