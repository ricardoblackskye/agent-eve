import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Post the clarifying questions back onto the original GitHub issue and stop.
 *
 * The product-owner workflow is: draft → if needs_clarification, comment the
 * questions on the *source* issue and wait. This tool performs the comment and
 * returns a marker so the agent knows not to create a story issue in this run.
 */
export default defineTool({
  description:
    "Post clarifying questions as a comment on the original GitHub issue that " +
    "requested the story, then stop and wait for the requester to answer. " +
    "Requires a GitHub token (GH_STORY_TOKEN / GH_RELEASE_TOKEN / GITHUB_TOKEN) " +
    "with issues: write scope.",
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    issueNumber: z.number().int().positive(),
    questions: z.array(z.string()).min(1),
  }),
  async execute({
    owner,
    repo,
    issueNumber,
    questions,
  }: {
    owner: string;
    repo: string;
    issueNumber: number;
    questions: string[];
  }) {
    const token =
      process.env.GH_STORY_TOKEN ||
      process.env.GH_RELEASE_TOKEN ||
      process.env.GITHUB_TOKEN;
    if (!token) {
      return {
        commented: false,
        error:
          "No GitHub token configured (GH_STORY_TOKEN / GH_RELEASE_TOKEN / GITHUB_TOKEN). " +
          "Cannot comment on the issue.",
      };
    }

    const body = [
      "👋 Thanks for the request! Before I can turn this into a structured user story, I need a few clarifications:",
      "",
      ...questions.map((q, i) => `${i + 1}. ${q}`),
      "",
      "_Once you reply, mention me again (or re-apply the `needs-story` label) and I'll generate the story._",
    ].join("\n");

    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          body: JSON.stringify({ body }),
        },
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 403) {
          return {
            commented: false,
            error: `GitHub API 403: the token lacks 'issues: write'. Details: ${err?.message || res.statusText}`,
          };
        }
        return {
          commented: false,
          error: `GitHub API ${res.status}: ${err?.message || res.statusText}`,
        };
      }

      return { commented: true, issueNumber };
    } catch (err) {
      return {
        commented: false,
        error: `Failed to comment: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
