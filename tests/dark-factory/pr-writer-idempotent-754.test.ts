import { describe, expect, it, vi } from "vitest";

import type { IssueWriterFetch } from "../../agent/lib/dark-factory/issue-writer";
import { GitHubPrWriter } from "../../agent/lib/dark-factory/pr-writer";

/**
 * #754. A re-run of an issue whose first run already opened a pull request must not be refused for
 * finding that pull request open. GitHub answers 422 to a create for an existing head, and the DoD
 * currently turns any failure of that call into `refused` - so a healthy re-run loses its verdict.
 *
 * The decision this pins: creating a resource that already exists is a SUCCESS that returns it.
 *
 * The control in the second case is the point: an implementation that forgives every 422 would pass
 * the first case and must fail this one.
 */
const ENV = { DF_WORKER_ALLOWED_REPOS: "owner/repo" };

function response(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const EXISTING = {
  number: 259,
  html_url: "https://github.com/owner/repo/pull/259",
  title: "the existing pull request",
  body: "body",
  head: { ref: "feat/dark-factory-258" },
  base: { ref: "main" },
};

const CONFLICT = {
  message: "Validation Failed",
  errors: [{ message: "A pull request already exists for owner:feat/dark-factory-258." }],
};

/** A fetch that always refuses the create, and answers the lookup with whatever it is given. */
function fetchRefusingCreate(lookup: unknown) {
  return vi.fn(async (url: string) => {
    if (String(url).includes("/pulls?head=")) return response(lookup, 200);
    return response(CONFLICT, 422);
  });
}

describe("creating a pull request that already exists (#754)", () => {
  it("resolves to the existing pull request rather than failing", async () => {
    const fetchImpl = fetchRefusingCreate([EXISTING]);
    const writer = new GitHubPrWriter({ token: "t", fetchImpl: fetchImpl as unknown as IssueWriterFetch, env: ENV });

    const result = await writer.createPullRequest("owner", "repo", {
      title: "title",
      head: "feat/dark-factory-258",
      body: "body",
      issue: 258,
    });

    expect(result.ok).toBe(true);
    expect(result.pr?.number).toBe(259);
  });

  // The control: with no matching pull request the conflict is a real failure, and it names the body.
  it("still fails when the conflict is not an existing pull request", async () => {
    const fetchImpl = fetchRefusingCreate([]);
    const writer = new GitHubPrWriter({ token: "t", fetchImpl: fetchImpl as unknown as IssueWriterFetch, env: ENV });

    const result = await writer.createPullRequest("owner", "repo", {
      title: "title",
      head: "feat/dark-factory-258",
      body: "body",
      issue: 258,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
    expect(JSON.stringify(result)).toMatch(/Validation Failed|already exists/i);
  });
});
