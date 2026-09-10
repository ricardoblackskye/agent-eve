import { defineTool } from "eve/tools";
import { z } from "zod";
import { runSprintReport } from "../../../lib/sprint-pipeline";

/**
 * Generate a sprint metrics report from the GitHub Kanban board and deliver it
 * to the requesting issue (a `reports/` file plus a linking comment). Defaults
 * to the configured board (user project `ricardoblackskye` #3, view 1) unless
 * overridden. Requires a token with `read:project` scope.
 */
export default defineTool({
  description:
    "Generate a sprint metrics report (cycle time, throughput, work-in-progress) " +
    "from the GitHub Kanban board and deliver it to the triggering issue. Reads " +
    "the board via the GitHub Projects GraphQL API and requires a token with " +
    "read:project scope.",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    issueNumber: z.number(),
    projectNumber: z.number().optional(),
    login: z.string().optional(),
  }),
  async execute({
    owner,
    repo,
    issueNumber,
    projectNumber,
    login,
  }: {
    owner: string;
    repo: string;
    issueNumber: number;
    projectNumber?: number;
    login?: string;
  }) {
    const token =
      process.env.GH_SPRINT_TOKEN ||
      process.env.GH_RELEASE_TOKEN ||
      process.env.GITHUB_TOKEN;
    if (!token) {
      return {
        delivered: false,
        error:
          "No GitHub token configured (set GH_SPRINT_TOKEN / GH_RELEASE_TOKEN " +
          "with read:project scope).",
      };
    }

    return runSprintReport({
      token,
      owner,
      repo,
      issueNumber,
      login: login || process.env.SPRINT_PROJECT_OWNER || "ricardoblackskye",
      projectNumber:
        projectNumber || Number(process.env.SPRINT_PROJECT_NUMBER || 3),
    });
  },
});
