import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description: "Unauthenticated requests are rejected with an error status.",
  tags: ["production"],
  async test(t) {
    const response = await t.target.fetch("/api/eve/v1/info", {
      headers: { authorization: "Bearer bad-token" },
    });
    t.check(
      response.status,
      satisfies((s: number) => s >= 400, "status >= 400 (rejected)"),
    );
  },
});
