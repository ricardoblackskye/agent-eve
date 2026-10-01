import { defineEval } from "eve/evals";

export default defineEval({
  description: "Basic smoke test: agent boots and responds to a greeting.",
  async test(t) {
    await t.send("Hello! What can you help me with?");
    t.succeeded();
    // `messageIncludes` is the framework's first-class reply assertion. The old
    // `t.check(t.reply, includes("you"))` reached into a context property that
    // eve 0.69.0 removed — see ADR 0011.
    t.messageIncludes("you");
  },
});
