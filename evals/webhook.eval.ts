import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description: "Verifies the GitHub webhook handler is operational.",
  tags: ["production"],
  async test(t) {
    // Test GET returns 405 Method Not Allowed
    const getResponse = await t.target.fetch("/api/github/webhook");
    t.check(
      getResponse.status,
      satisfies(
        (s: number) => s === 405,
        "GET /api/github/webhook returns 405",
      ),
    );

    // Test ping event returns pong
    const pingResponse = await t.target.fetch("/api/github/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "ping" },
      body: JSON.stringify({}),
    });
    const pingData = await pingResponse.json();
    t.check(
      pingResponse.status,
      satisfies((s: number) => s === 200, "POST ping returns 200"),
    );
    t.check(
      pingData?.message,
      satisfies(
        (m: string) => m === "pong",
        "ping response contains pong",
      ),
    );

    // Test invalid body returns error
    const badResponse = await t.target.fetch("/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
      },
      body: JSON.stringify({}),
    });
    const badData = await badResponse.json();
    t.check(
      badData?.error,
      satisfies(
        (e: string) => e === "No PR data",
        "empty PR body returns No PR data error",
      ),
    );

    // Test valid PR event triggers Eve API call (via response envelope)
    const prResponse = await t.target.fetch("/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
      },
      body: JSON.stringify({
        action: "opened",
        pull_request: {
          number: 1,
          title: "Test PR",
          body: "Test body",
          html_url: "https://github.com/test/repo/pull/1",
          labels: [],
          base: { ref: "main" },
          head: { ref: "feat/test" },
        },
        repository: { full_name: "test/repo" },
      }),
    });
    const prData = await prResponse.json();
    t.check(
      prData?.ok,
      satisfies((o: boolean) => o === true, "valid PR returns ok: true"),
    );
    t.check(
      prData?.eveApiResult,
      satisfies(
        (r: string) => r === "accepted",
        "Eve API session was accepted",
      ),
    );
  },
});