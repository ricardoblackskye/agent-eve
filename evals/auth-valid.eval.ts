import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description:
    "Agent responds when called with a valid bearer token (via EVE_EVAL_AUTH_TOKEN).",
  async test(t) {
    await t.send("Hello! What can you help me with?");
    t.succeeded();
    t.check(t.reply, includes("assist"));
  },
});