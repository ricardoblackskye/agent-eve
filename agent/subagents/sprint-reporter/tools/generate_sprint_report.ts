import { defineTool } from "eve/tools";
import { z } from "zod";
import { runSprintReport } from "../../../lib/sprint-pipeline";
import {
  loadRunnerConfig,
  resolveBoardSetting,
} from "../../../lib/dark-factory/runner-config";

/**
 * Generate a sprint metrics report from the GitHub Kanban board and deliver it
 * to the requesting issue as a GitHub Gist (Markdown + PDF), with a linking
 * comment. Writing to a gist (rather than the repo's `reports/` folder)
 * sidesteps the main-branch ruleset and avoids orphaned files.
 *
 * The board is RESOLVED, not assumed: an explicit `projectOwner`/`projectNumber`,
 * then SPRINT_PROJECT_OWNER/SPRINT_PROJECT_NUMBER, then the repository's entry in
 * `dark-factory.config.json`. With none of those it REFUSES and says so, rather
 * than reporting to a board nobody configured (#348). Requires a token with
 * `read:project` AND `gist` scopes.
 */
export default defineTool({
  description:
    "Generate a sprint metrics report (cycle time, throughput, work-in-progress) " +
    "from the GitHub Kanban board and deliver it to the triggering issue as a " +
    "GitHub Gist (Markdown + PDF) with a linking comment. Reads the board via " +
    "the GitHub Projects GraphQL API; requires a token with read:project + gist scopes.",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    issueNumber: z.number(),
    projectNumber: z.number().optional(),
    projectOwner: z.string().optional(),
  }),
  async execute({
    owner,
    repo,
    issueNumber,
    projectNumber,
    projectOwner,
  }: {
    owner: string;
    repo: string;
    issueNumber: number;
    projectNumber?: number;
    projectOwner?: string;
  }) {
    const token =
      process.env.GH_SPRINT_TOKEN ||
      process.env.GH_RELEASE_TOKEN ||
      process.env.GITHUB_TOKEN;
    if (!token) {
      return {
        ok: false,
        error:
          "No GitHub token configured (set GH_SPRINT_TOKEN / GH_RELEASE_TOKEN " +
          "with read:project + gist scope).",
      };
    }

    // Resolve the gist owner = the token's own login. A gist is owned by its
    // creator, so writing `reports` to the actor's gist namespace requires the
    // token's login. A missing/invalid token here fails fast with a clear error.
    let gistOwner: string | undefined;
    try {
      const userRes = await fetch("https://api.github.com/user", {
        method: "GET",
        headers: {
          authorization: "Bearer " + token,
          accept: "application/vnd.github+json",
        },
      });
      if (userRes.ok) {
        const userData = (await userRes.json()) as { login?: string };
        gistOwner = userData.login;
      }
    } catch {
      gistOwner = undefined;
    }
    if (!gistOwner) {
      return {
        ok: false,
        error:
          "Could not resolve the token's GitHub login (needed to own the gist). " +
          "Ensure the token is valid and has 'gist' scope.",
      };
    }

    // #348: resolution lives in one place so the precedence, the validation and the refusal are testable
    // without a network call - and so this tool cannot drift from the rest of the Factory.
    const configResult = loadRunnerConfig();
    if (!configResult.ok) {
      return { ok: false, error: configResult.error };
    }

    const board = resolveBoardSetting({
      repo: `${owner}/${repo}`,
      config: configResult.config,
      explicit: { login: projectOwner, number: projectNumber },
      env: process.env,
    });
    if (!board.ok) {
      return { ok: false, error: board.error };
    }

    return runSprintReport({
      token,
      owner,
      repo,
      issueNumber,
      gistOwner,
      projectOwner: board.login,
      projectNumber: board.number,
    });
  },
});
