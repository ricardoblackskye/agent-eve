import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  getProvider,
  sanitizeOwnerId,
  sanitizeRepoName,
  type CanonicalPayload,
} from "../../../lib/backlog-provider";
import { UserStorySchema } from "../../../lib/story-schema";

/**
 * Publish a finalized user story payload to the configured backlog provider.
 *
 * R1 default is `console` (dry run) — nothing is created until the operator
 * passes `provider: "github"`. The GitHub provider creates a new *story* issue
 * linked back to the source issue via `sourceIssueNumber`. Invalid payloads are
 * rejected before any network call.
 */
export default defineTool({
  description:
    "Publish a finalized user story payload to the configured backlog provider. " +
    "In this release the default provider is 'console', which performs a dry run " +
    "and does NOT create a work item. Pass provider: 'github' to create a linked " +
    "story issue on GitHub (requires a token with issues: write scope).",
  inputSchema: z.object({
    payload: z.record(z.string(), z.unknown()),
    provider: z.string().optional().default("console"),
    sourceIssueNumber: z.number().optional(),
    owner: z.string().optional(),
    repo: z.string().optional(),
  }),
  async execute({
    payload,
    provider,
    sourceIssueNumber,
    owner,
    repo,
  }: {
    payload: Record<string, unknown>;
    provider?: string;
    sourceIssueNumber?: number;
    owner?: string;
    repo?: string;
  }) {
    const storyCheck = UserStorySchema.safeParse(
      (payload as Record<string, unknown>).story,
    );
    if (!storyCheck.success) {
      return {
        delivered: false,
        error: `Refusing to publish an invalid story: ${storyCheck.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      };
    }

    // Sanitize owner/repo BEFORE they enter the canonical payload, so every
    // provider (including the console/dry-run provider that may echo the payload)
    // receives already-safe identifier values. The owner uses GitHub's stricter
    // character class (alphanumerics + hyphens only, ≤39 chars); the repo name
    // allows dots/underscores and is capped at ≤100 chars. The GitHubProvider
    // still re-sanitizes at its boundary as defense in depth.
    const safeOwner = sanitizeOwnerId(owner);
    const safeRepo = sanitizeRepoName(repo);

    const canonical = {
      ...(payload as unknown as CanonicalPayload),
      sourceIssueNumber,
      ...(safeOwner ? { owner: safeOwner } : {}),
      ...(safeRepo ? { repo: safeRepo } : {}),
    };

    const result = await getProvider(provider || "console").publish(canonical);
    return { ...result, payload: canonical };
  },
});
