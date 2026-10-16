import { defineTool } from "eve/tools";
import { z } from "zod";
import { loadRunnerConfig, resolveOwnerRepo } from "../../../lib/dark-factory/runner-config";

/**
 * Read the current content of releasenotes.md from the GitHub repository.
 * The Release Manager calls this first to read existing notes,
 * so it can prepend new release entries.
 */
export default defineTool({
  description:
    "Read the current content of releasenotes.md from the GitHub repository. " +
    "Returns the file content (decoded from base64) and the file SHA (needed for updates). " +
    "Returns an empty content and null SHA if the file does not exist. " +
    "Accepts optional owner and repo; falls back to VERCEL_GIT_REPO_OWNER/SLUG env vars. " +
    "Requires GH_RELEASE_TOKEN environment variable.",
  inputSchema: z.object({
    owner: z.string().optional(),
    repo: z.string().optional(),
  }),
  async execute({ owner, repo }) {
    const token = process.env.GH_RELEASE_TOKEN;
    if (!token) {
      return {
        success: false,
        error:
          "GH_RELEASE_TOKEN environment variable is not set. Cannot read release notes.",
        content: null,
        sha: null,
      };
    }

    // #348 R2: RESOLVED, not composed. A literal owner behind an `||` is a value nobody chose,
    // and it reads as care exactly like the allow-list default that defeated its own gate.
    const configResult = loadRunnerConfig();
    if (!configResult.ok) {
      return { success: false, error: configResult.error, content: null, sha: null };
    }

    const target = resolveOwnerRepo({
      owner,
      repo,
      config: configResult.config,
      envOwnerValue: process.env.VERCEL_GIT_REPO_OWNER,
      envRepoValue: process.env.VERCEL_GIT_REPO_SLUG,
    });
    if (!target.ok) {
      return { success: false, error: target.error, content: null, sha: null };
    }

    const targetOwner = target.owner;
    const targetRepo = target.repo;

    try {
      const response = await fetch(
        `https://api.github.com/repos/${targetOwner}/${targetRepo}/contents/releasenotes.md`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github.v3+json",
          },
        },
      );

      if (response.status === 404) {
        return {
          success: true,
          content: null,
          sha: null,
          message:
            "releasenotes.md does not exist yet. A new file will be created.",
        };
      }

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${response.status} ${response.statusText}`,
          content: null,
          sha: null,
        };
      }

      const data = await response.json();
      const decoded = Buffer.from(data.content, "base64").toString("utf-8");

      return {
        success: true,
        content: decoded,
        sha: data.sha,
        message: `File exists (${data.size} bytes). SHA: ${data.sha.slice(0, 7)}...`,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to read releasenotes.md: ${err instanceof Error ? err.message : String(err)}`,
        content: null,
        sha: null,
      };
    }
  },
});
