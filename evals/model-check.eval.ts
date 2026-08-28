import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "Verifies the agent uses nvidia/nemotron-3-ultra-550b-a55b:free model.",
  tags: ["production"],
  async test(t) {
    const infoResponse = await t.target.fetch("/eve/v1/info");
    const info = await infoResponse.json();
    const modelId: string = info?.agent?.model?.id;
    t.check(
      modelId,
      satisfies(
        (id: string) => id.includes("nemotron-3-ultra"),
        "model is nvidia/nemotron-3-ultra-550b-a55b:free",
      ),
    );
  },
});
