import type { UserStory } from "./story-schema";
import { finalizeLabels } from "./story-labels";

/**
 * Platform-agnostic backlog provider seam.
 *
 * The product-owner subagent produces a `UserStory` (see ./story-schema). That
 * story is serialised to a `CanonicalPayload` that contains NO provider-specific
 * fields — no GitHub issue numbers, no Jira keys, no Azure DevOps IDs. Each
 * concrete provider (GitHub, Azure DevOps, Jira, ...) is responsible for mapping
 * the canonical payload onto its own API. R1 ships only the GitHub provider;
 * the console provider is a safe default that never performs a network call and
 * is used for dry runs / local development.
 */
export interface CanonicalPayload {
  story: UserStory;
  acceptanceCriteria: { given: string; when: string; then: string }[];
  examples: { input: string; output: string }[];
  constraints: string[];
  nfrs: { performance: string; security: string; latency: string };
  openQuestions: string[];
  /** The GitHub issue that triggered generation; stamped onto the new story issue. */
  sourceIssueNumber?: number;
  /**
   * Source repo the trigger issue lives in. When set, the GitHub provider
   * creates the child story in THIS repo (and finalizes/linking there) instead
   * of the hardcoded `agent-eve` default. Falls back to the
   * GITHUB_REPO_OWNER/GITHUB_REPO_NAME env vars, then to `ricardoblackskye`/
   * `agent-eve`. Fixes issue #119 (stories were always written to agent-eve).
   */
  owner?: string;
  /** See `owner`. The repo (within `owner`) to target. */
  repo?: string;
}

export function toCanonicalPayload(story: UserStory): CanonicalPayload {
  return {
    story,
    acceptanceCriteria: story.acceptanceCriteria,
    examples: story.examples,
    constraints: story.constraints,
    nfrs: story.nfrs,
    openQuestions: story.openQuestions,
  };
}

/**
 * Allowlist sanitizer for a GitHub owner/repo identifier fragment. Strips
 * everything outside `[A-Za-z0-9_.-]` (no slashes, newlines, control chars,
 * markdown). Shared so every provider — including the console/dry-run provider
 * that may echo the payload — receives already-safe identifier values.
 *
 * Used both in `publish_story` (pre-provider) and `GitHubProvider.publish`
 * (boundary defense in depth).
 */
export function sanitizeRepoId(value: string | undefined): string {
  return (value || "").replace(/[^A-Za-z0-9_.-]/g, "");
}

/**
 * Resolve a safe owner/repo pair for the GitHub provider.
 *
 * Priority: payload value (already sanitised upstream by `publish_story`) →
 * env var → built-in default. Each source is sanitised; if an ENV var is set
 * but strips to empty (e.g. whitespace-only misconfiguration), a warning is
 * emitted so the operator is not silently redirected to the default repo.
 */
export function sanitizeOwnerRepo(
  payloadOwner: string | undefined,
  payloadRepo: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { owner: string; repo: string; warnings: string[] } {
  const warnings: string[] = [];
  const fallbackOwner = "ricardoblackskye";
  const fallbackRepo = "agent-eve";

  const rawOwnerEnv = env.GITHUB_REPO_OWNER;
  const rawRepoEnv = env.GITHUB_REPO_NAME;
  if (rawOwnerEnv && sanitizeRepoId(rawOwnerEnv) === "") {
    warnings.push(
      `GITHUB_REPO_OWNER is set but contains no valid identifier characters; ` +
        `falling back to '${fallbackOwner}'.`,
    );
  }
  if (rawRepoEnv && sanitizeRepoId(rawRepoEnv) === "") {
    warnings.push(
      `GITHUB_REPO_NAME is set but contains no valid identifier characters; ` +
        `falling back to '${fallbackRepo}'.`,
    );
  }

  const owner =
    sanitizeRepoId(payloadOwner) ||
    sanitizeRepoId(rawOwnerEnv) ||
    fallbackOwner;
  const repo =
    sanitizeRepoId(payloadRepo) || sanitizeRepoId(rawRepoEnv) || fallbackRepo;
  return { owner, repo, warnings };
}

export interface PublishResult {
  delivered: boolean;
  mode: "dry-run" | "live";
  providerId: string;
  url?: string;
  /** The id/number of the newly created item (e.g. GitHub issue number). */
  issueNumber?: number;
  /** Labels applied/removed on the source issue after a successful publish. */
  labelTransitions?: { add: string[]; remove: string[] };
  /** Non-fatal transition failures surfaced so they are observable, not silent. */
  warnings?: string[];
  error?: string;
  /** True when a child story already existed for this source issue (dedup skip). */
  duplicate?: boolean;
}

export interface BacklogProvider {
  id: string;
  publish(payload: CanonicalPayload): Promise<PublishResult>;
}

const GITHUB_PROVIDER_ID = "github";

/**
 * Fixed prefix of the cross-reference comment posted on the source issue after
 * a successful story publish. Used both to build that comment and to detect an
 * existing child (Option B dedup) without an extra search call.
 */
const CHILD_LINK_PREFIX = "📄 User story generated for this issue:";

function githubConfiguredToken(): string | undefined {
  return (
    process.env.GH_STORY_TOKEN ||
    process.env.GH_RELEASE_TOKEN ||
    process.env.GITHUB_TOKEN
  );
}

/**
 * The GitHub provider creates a new *story* issue linked back to the source
 * issue via `sourceIssueNumber`. It is registered but NOT the default — the
 * default remains `console` (dry run) so nothing is created until the operator
 * opts in. Requires `issues: write` scope on the token; a 403 is reported with
 * an explicit scope message rather than swallowed.
 *
 * Phase 4: after a successful create, the provider also finalizes the *source*
 * issue — posts a cross-reference comment (the observable parent→child link),
 * adds `user-story-added`, and removes `needs-story`. Finalization is
 * idempotent: the child-link comment is skipped if one already references the
 * story, and deleting an already-absent label (404) is treated as success
 * rather than a warning, so a retry never piles up duplicate comments or
 * spurious errors.
 */
class GitHubProvider implements BacklogProvider {
  id = GITHUB_PROVIDER_ID;

  async publish(payload: CanonicalPayload): Promise<PublishResult> {
    const token = githubConfiguredToken();
    if (!token) {
      return {
        delivered: false,
        mode: "dry-run",
        providerId: this.id,
        error:
          "No GitHub token configured (set GH_STORY_TOKEN / GH_RELEASE_TOKEN / GITHUB_TOKEN). " +
          "Refusing to create a story issue.",
      };
    }

    // Resolve owner/repo through the shared helper (boundary sanitization +
    // env-misconfig warnings). `publish_story` already sanitizes upstream, so this
    // is defense-in-depth and also surfaces operator mistakes (e.g. a whitespace-
    // only GITHUB_REPO_OWNER) instead of silently falling back to defaults.
    const { owner, repo, warnings: ownerWarnings } = sanitizeOwnerRepo(
      payload.owner,
      payload.repo,
    );

    // Allow-list guard (PR #120 review): the resolved target repo is where the
    // app's token will create an issue, so it MUST be an explicitly approved
    // repository. Without this, a malicious/compromised subagent step could
    // direct the story into an arbitrary repo using our credentials.
    const allowed = (process.env.STORY_ALLOWED_REPOS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.length > 0) {
      const target = `${owner}/${repo}`;
      if (!allowed.includes(target)) {
        return {
          delivered: false,
          mode: "dry-run",
          providerId: this.id,
          error:
              `Refusing to publish: target repo '${target}' is not in the ` +
              `STORY_ALLOWED_REPOS allow-list (${allowed.join(", ")}).`,
            ...(ownerWarnings.length ? { warnings: ownerWarnings } : {}),
          };
      }
    }
    const story = payload.story;

    // Option B dedup: if a child story already exists for this source issue,
    // skip creation. Two signals, most deterministic first:
    //   1. the formal sub-issue relationship (structural, pagination-free), and
    //   2. the child-link comment on the source (paginated fallback).
    // NOTE: this check-then-create is not atomic — GitHub has no conditional
    // issue create, so a genuinely concurrent double-fire can still race
    // through. In practice the trigger is a single webhook per label-add and
    // Option A already blocks the common re-label path, so the residual window
    // is negligible; fully closing it needs an external idempotency store.
    if (payload.sourceIssueNumber) {
      const sourceBase = `https://api.github.com/repos/${owner}/${repo}/issues/${payload.sourceIssueNumber}`;
      const alreadyLinked =
        (await this.hasChildSubIssue(
          token,
          owner,
          repo,
          payload.sourceIssueNumber,
        )) || (await this.hasComment(token, sourceBase, CHILD_LINK_PREFIX));
      if (alreadyLinked) {
        return {
          delivered: false,
          mode: "dry-run",
          providerId: this.id,
          duplicate: true,
          error: `A story issue already exists for source issue #${payload.sourceIssueNumber}; skipping.`,
        };
      }
    }

    const sourceRef = payload.sourceIssueNumber
      ? `[#${payload.sourceIssueNumber}](https://github.com/${owner}/${repo}/issues/${payload.sourceIssueNumber})`
      : "???";

    const issueBody = [
      `> Generated by the Product Owner subagent from ${sourceRef}`,
      "",
      `**Intent**`,
      story.intent,
      "",
      `**Acceptance Criteria**`,
      ...story.acceptanceCriteria.map(
        (c) => `- given ${c.given}, when ${c.when}, then ${c.then}`,
      ),
      "",
      `**Examples**`,
      ...story.examples.map((e) => `- \`${e.input}\` → \`${e.output}\``),
      "",
      `**Constraints**`,
      ...story.constraints.map((c) => `- ${c}`),
      "",
      `**NFRs**`,
      `- performance: ${story.nfrs.performance}`,
      `- security: ${story.nfrs.security}`,
      `- latency: ${story.nfrs.latency}`,
    ].join("\n");

    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          body: JSON.stringify({
            title: `[Story] ${story.title}`,
            body: issueBody,
          }),
        },
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 403) {
          return {
            delivered: false,
            mode: "dry-run",
            providerId: this.id,
            error:
              `GitHub API 403: the token lacks 'issues: write'. ` +
              `Details: ${err?.message || res.statusText}`,
          };
        }
        return {
          delivered: false,
          mode: "dry-run",
          providerId: this.id,
          error: `GitHub API ${res.status}: ${err?.message || res.statusText}`,
        };
      }

      const data = (await res.json()) as {
        html_url: string;
        number: number;
        node_id: string;
      };

      const warnings: string[] = [];
      let labelTransitions: { add: string[]; remove: string[] } | undefined;

      if (payload.sourceIssueNumber) {
        labelTransitions = finalizeLabels({ success: true });
        await this.finalizeSourceIssue(
          token,
          owner,
          repo,
          payload.sourceIssueNumber,
          data.html_url,
          labelTransitions,
          warnings,
        );
        await this.linkParent(
          token,
          owner,
          repo,
          payload.sourceIssueNumber,
          data.node_id,
          warnings,
        );
      }

      return {
        delivered: true,
        mode: "live",
        providerId: this.id,
        url: data.html_url,
        issueNumber: data.number,
        labelTransitions,
        warnings: [...ownerWarnings, ...warnings].length
          ? [...ownerWarnings, ...warnings]
          : undefined,
      };
    } catch (err) {
      return {
        delivered: false,
        mode: "dry-run",
        providerId: this.id,
        error: `Failed to create story issue: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async finalizeSourceIssue(
    token: string,
    owner: string,
    repo: string,
    sourceIssueNumber: number,
    storyUrl: string,
    transitions: { add: string[]; remove: string[] },
    warnings: string[],
  ): Promise<void> {
    const base = `https://api.github.com/repos/${owner}/${repo}/issues/${sourceIssueNumber}`;
    const authHeaders = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    };

    // 1. Cross-reference comment (the observable parent→child link), idempotent:
    //    skip the POST when a comment already references the story URL.
    const childLinkBody = `${CHILD_LINK_PREFIX} ${storyUrl}`;
    if (!(await this.hasComment(token, base, storyUrl))) {
      try {
        const commentRes = await fetch(`${base}/comments`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ body: childLinkBody }),
        });
        if (!commentRes.ok) {
          warnings.push(`child-link comment failed (${commentRes.status})`);
        }
      } catch (err) {
        warnings.push(
          `child-link comment failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 2. Add the completion label(s) — POST is a no-op if already present.
    for (const label of transitions.add) {
      try {
        const addRes = await fetch(`${base}/labels`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ labels: [label] }),
        });
        if (!addRes.ok) {
          warnings.push(`add label '${label}' failed (${addRes.status})`);
        }
      } catch (err) {
        warnings.push(
          `add label '${label}' failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 3. Remove the trigger label(s). A 404 means the label is already gone,
    //    which is the desired end state — treat it as success, not a warning.
    for (const label of transitions.remove) {
      try {
        const delRes = await fetch(
          `${base}/labels/${encodeURIComponent(label)}`,
          {
            method: "DELETE",
            headers: authHeaders,
          },
        );
        if (!delRes.ok && delRes.status !== 404) {
          warnings.push(`remove label '${label}' failed (${delRes.status})`);
        }
      } catch (err) {
        warnings.push(
          `remove label '${label}' failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * True when the source issue already has at least one sub-issue (i.e. a child
   * story was linked as its parent). This is the primary, deterministic dedup
   * signal: it reads a structural relationship via `totalCount`, so it has no
   * pagination problem and no reliance on a best-effort comment.
   */
  private async hasChildSubIssue(
    token: string,
    owner: string,
    repo: string,
    sourceIssueNumber: number,
  ): Promise<boolean> {
    try {
      const srcRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${sourceIssueNumber}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        },
      );
      if (!srcRes.ok) return false;
      const src = (await srcRes.json()) as { node_id?: string };
      if (!src.node_id) return false;

      const query = `
        query SubIssueCount($id: ID!) {
          node(id: $id) {
            ... on Issue {
              subIssues { totalCount }
            }
          }
        }
      `;
      const gqlRes = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables: { id: src.node_id } }),
      });
      if (!gqlRes.ok) return false;
      const body = (await gqlRes.json()) as {
        data?: { node?: { subIssues?: { totalCount?: number } } };
      };
      return (body.data?.node?.subIssues?.totalCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * True when any comment on the issue (across ALL pages) contains the marker.
   * Paginates with `per_page=100` so a child-link comment beyond GitHub's
   * default first page (30) is still found.
   */
  private async hasComment(
    token: string,
    base: string,
    marker: string,
  ): Promise<boolean> {
    const needle = marker.trim().toLowerCase();
    try {
      let page = 1;
      for (;;) {
        const res = await fetch(`${base}/comments?per_page=100&page=${page}`, {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        });
        if (!res.ok) return false;
        const comments = (await res.json()) as Array<{ body?: string }>;
        if (
          comments.some((c) =>
            (c.body || "").trim().toLowerCase().includes(needle),
          )
        ) {
          return true;
        }
        if (comments.length < 100) return false;
        page++;
      }
    } catch {
      // Can't confirm; return false so the caller still attempts the comment
      // (best-effort — the duplicate guard is an optimization, not a hard gate).
      return false;
    }
  }

  /**
   * Set the source issue as the child's formal parent via GitHub sub-issues
   * (GraphQL). Best-effort: any failure surfaces as a warning rather than
   * failing the publish, because the child issue still exists and the
   * cross-reference link in its body still holds.
   */
  private async linkParent(
    token: string,
    owner: string,
    repo: string,
    sourceIssueNumber: number,
    childNodeId: string,
    warnings: string[],
  ): Promise<void> {
    try {
      const srcRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${sourceIssueNumber}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        },
      );
      if (!srcRes.ok) {
        warnings.push(
          `parent-link: source issue fetch failed (${srcRes.status})`,
        );
        return;
      }
      const src = (await srcRes.json()) as { node_id?: string };
      if (!src.node_id) {
        warnings.push("parent-link: source issue has no node_id");
        return;
      }

      const query = `
        mutation AddSubIssue($issueId: ID!, $subIssueId: ID!) {
          addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
            issue { id }
          }
        }
      `;
      const gqlRes = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables: { issueId: src.node_id, subIssueId: childNodeId },
        }),
      });
      if (!gqlRes.ok) {
        warnings.push(
          `parent-link: GraphQL addSubIssue failed (${gqlRes.status})`,
        );
        return;
      }
      const gqlBody = (await gqlRes.json()) as { errors?: unknown[] };
      if (gqlBody.errors?.length) {
        warnings.push("parent-link: GraphQL addSubIssue returned errors");
      }
    } catch (err) {
      warnings.push(
        `parent-link: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

class ConsoleProvider implements BacklogProvider {
  id = "console";
  async publish(payload: CanonicalPayload): Promise<PublishResult> {
    return {
      delivered: false,
      mode: "dry-run",
      providerId: this.id,
    };
  }
}

class UnknownProvider implements BacklogProvider {
  constructor(private readonly requestedId: string) {}
  id = "unknown";
  async publish(_payload: CanonicalPayload): Promise<PublishResult> {
    return {
      delivered: false,
      mode: "dry-run",
      providerId: this.requestedId,
      error: `Provider '${this.requestedId}' is not configured.`,
    };
  }
}

const REGISTRY: Record<string, () => BacklogProvider> = {
  console: () => new ConsoleProvider(),
  [GITHUB_PROVIDER_ID]: () => new GitHubProvider(),
};

/**
 * Cheap runtime check that the configured GitHub token actually carries
 * `issues: write`. The plan flagged this as an *unverified* risk: the token was
 * only ever used for `contents`, so a missing `issues` scope would fail silently
 * at issue-creation time. We probe `/user` + `/rate_limit` and inspect the
 * `X-OAuth-Scopes` header so a missing scope surfaces as an explicit message
 * instead of a confusing 403 on the first create.
 */
export async function checkGitHubTokenScope(): Promise<{
  ok: boolean;
  scopes: string[];
  error?: string;
}> {
  const token = githubConfiguredToken();
  if (!token) {
    return { ok: false, scopes: [], error: "no token configured" };
  }
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
    });
    const scopesHeader =
      res.headers.get("x-oauth-scopes") ||
      res.headers.get("X-OAuth-Scopes") ||
      "";
    const scopes = scopesHeader
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const hasIssuesWrite = scopes.some((s) =>
      /^(issues: write|repo|public_repo|write:org)$/i.test(s),
    );
    if (!res.ok) {
      return { ok: false, scopes, error: `token rejected (${res.status})` };
    }
    return { ok: hasIssuesWrite, scopes };
  } catch (err) {
    return {
      ok: false,
      scopes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve a backlog provider by id. Falls back to the console provider (dry
 * run) for unknown ids so callers never have to null-check; an unknown provider
 * reports `delivered: false` rather than throwing.
 */
export function getProvider(id: string): BacklogProvider {
  const factory = REGISTRY[id];
  if (factory) return factory();
  return new UnknownProvider(id);
}
