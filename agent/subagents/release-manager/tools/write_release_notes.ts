import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Write release notes content to releasenotes.md in the GitHub repository.
 * Creates the file if it doesn't exist, updates it if it does.
 * Requires GH_RELEASE_TOKEN environment variable.
 */
export default defineTool({
  description:
    "Write release notes content to releasenotes.md in the GitHub repository. " +
    "Creates the file if it doesn't exist, updates it if it does. " +
    "Pass existing file SHA when updating to prevent conflicts. " +
    "Requires GH_RELEASE_TOKEN environment variable.",
  inputSchema: z.object({
    content: z.string().min(1, "Content is required"),
    commitMessage: z
      .string()
      .optional()
      .default("docs: update release notes"),
    prNumber: z.number().optional(),
    existingSha: z.string().nullable().optional(),
  }),
  async execute({ content, commitMessage, prNumber, existingSha }) {
    const token = process.env.GH_RELEASE_TOKEN;
    if (!token) {
      return {
        success: false,
        error:
          "GH_RELEASE_TOKEN environment variable is not set. Cannot write release notes.",
      };
    }

    const owner = process.env.VERCEL_GIT_REPO_OWNER || "ricardoblackskye";
    const repo = process.env.VERCEL_GIT_REPO_SLUG || "agent-eve";

    // Build commit message
    const msg = prNumber
      ? `${commitMessage} (#${prNumber})`
      : commitMessage;

    // Encode content to base64
    const encoded = Buffer.from(content, "utf-8").toString("base64");

    // Build the API request body
    const body: Record<string, unknown> = {
      message: msg,
      content: encoded,
    };

    // If we have a SHA, include it (update existing file)
    if (existingSha) {
      body.sha = existingSha;
    }

    try {
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/releasenotes.md`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/vnd.github.v3+json",
          },
          body: JSON.stringify(body),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error (${response.status}): ${data?.message || response.statusText}`,
        };
      }

      return {
        success: true,
        sha: data.content?.sha || data.commit?.sha,
        url: data.content?.html_url || data.commit?.html_url,
        message: `releasenotes.md updated successfully. Commit: ${data.commit?.sha?.slice(0, 7) || "unknown"}`,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to write releasenotes.md: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});