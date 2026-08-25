import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "Verifies the multi-repo configuration is valid and the webhook routes correctly.",
  tags: ["production"],
  async test(t) {
    // Test webhook rejects unknown repos (no defaults configured)
    const unknownRepoResponse = await t.target.fetch("/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
      },
      body: JSON.stringify({
        action: "opened",
        pull_request: {
          number: 1,
          title: "Test",
          body: "",
          html_url: "https://github.com/unknown/repo/pull/1",
          labels: [],
          base: { ref: "main" },
          head: { ref: "feat/test" },
        },
        repository: { full_name: "unknown/repo" },
      }),
    });
    const unknownData = await unknownRepoResponse.json();
    t.check(
      unknownData?.error?.includes("unknown repo") ||
        unknownData?.error?.includes("not configured") ||
        unknownData?.error?.includes("Unknown"),
      satisfies(
        (found: boolean) => found === true,
        "unknown repo returns an error",
      ),
    );

    // Test known repo is accepted
    const knownRepoResponse = await t.target.fetch("/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
      },
      body: JSON.stringify({
        action: "opened",
        pull_request: {
          number: 1,
          title: "Test",
          body: "",
          html_url: "https://github.com/ricardoblackskye/agent-eve/pull/1",
          labels: [],
          base: { ref: "main" },
          head: { ref: "feat/test" },
        },
        repository: { full_name: "ricardoblackskye/agent-eve" },
      }),
    });
    const knownData = await knownRepoResponse.json();
    t.check(
      knownData?.ok === true,
      satisfies(
        (ok: boolean) => ok === true,
        "known repo returns ok: true",
      ),
    );
  },
});