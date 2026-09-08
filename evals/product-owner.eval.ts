import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "Verifies the product-owner subagent is registered and story-shaped.",
  async test(t) {
    const infoResponse = await t.target.fetch("/eve/v1/info");
    const info = await infoResponse.json();
    const jsonStr = JSON.stringify(info);

    t.check(
      jsonStr.includes("product-owner"),
      satisfies(
        (found: boolean) => found === true,
        "product-owner subagent is registered",
      ),
    );
  },
});
