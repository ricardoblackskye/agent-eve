import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description: "Verifies the frontend chat page loads and returns HTML.",
  tags: ["production"],
  async test(t) {
    const response = await t.target.fetch("/");
    const text = await response.text();
    t.check(
      response.status,
      satisfies((s: number) => s === 200, "home page returns 200"),
    );
    t.check(
      text,
      satisfies(
        (html: string) => html.includes("Eve Agent"),
        "page contains 'Eve Agent'",
      ),
    );
  },
});