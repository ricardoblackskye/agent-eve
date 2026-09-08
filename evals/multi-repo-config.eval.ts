import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { canSign, signPayload, signingSecret } from "./helpers/sign";

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
    const unknownErrorMsg =
      typeof unknownData?.error === "string"
        ? unknownData.error
        : JSON.stringify(unknownData || "");
    t.check(
      unknownErrorMsg.toLowerCase().includes("unknown") ||
        unknownErrorMsg.toLowerCase().includes("not configured"),
      satisfies(
        (found: boolean) => found === true,
        "unknown repo returns an error",
      ),
    );

    // Test known repo is accepted.
    // Production rejects unsigned webhooks with 401 by design, so sign the
    // request when a signing secret is available. Without one (local `eve
    // eval`, CI without the secret) skip rather than assert insecure behaviour.
    if (!canSign()) {
      t.succeeded();
      return;
    }

    const knownRepoBody = JSON.stringify({
      action: "opened",
      pull_request: {
        number: 1,
        title: "Test",
        body: "",
        html_url: "https://github.com/test/repo/pull/1",
        labels: [],
        base: { ref: "main" },
        head: { ref: "feat/test" },
      },
      repository: { full_name: "test/repo" },
    });

    const knownRepoResponse = await t.target.fetch("/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signPayload(knownRepoBody, signingSecret()!),
      },
      body: knownRepoBody,
    });
    const knownData = await knownRepoResponse.json();
    t.check(
      knownRepoResponse.status === 200 &&
        knownData?.ok === true &&
        (knownData?.eveApiResult === "accepted" ||
          knownData?.eveApiResult === "skipped"),
      satisfies(
        (accepted: boolean) => accepted === true,
        "known repo returns status 200 and ok: true",
      ),
    );
  },
});
