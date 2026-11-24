/**
 * Dark Factory — PR Writer (#164).
 *
 * Provides the GitHub pull request creation primitive for the orchestrator.
 *
 * CRITICAL INVARIANTS:
 * 1. Opening a PR is the terminal automated action.
 * 2. Merging is STRICTLY forbidden for the factory — this module does NOT
 *    implement, expose, or call any merge endpoints.
 * 3. Fail-closed: repository MUST be in DF_WORKER_ALLOWED_REPOS.
 * 4. Injected fetchImpl for offline/deterministic testing without network calls.
 */

import { resolveWorkerAllowedRepos } from "./credentials";
import { resolveIssueToken, type IssueWriterFetch } from "./issue-writer";

export interface PullRequestDetails {
  number: number;
  url: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface CreatePullRequestOptions {
  title: string;
  head: string;
  base?: string;
  body: string;
  issue: number;
}

export interface CreatePullRequestResult {
  ok: boolean;
  status?: number;
  pr?: PullRequestDetails;
  error?: string;
}

export interface GitHubPrWriterOptions {
  token?: string;
  fetchImpl?: IssueWriterFetch;
  env?: Record<string, string | undefined>;
}

export class GitHubPrWriter {
  private readonly token?: string;
  private readonly fetchImpl: IssueWriterFetch;
  private readonly env: Record<string, string | undefined>;
  private readonly apiBase = "https://api.github.com";

  constructor(options: GitHubPrWriterOptions = {}) {
    this.env = options.env ?? process.env;
    this.token = options.token ?? resolveIssueToken(this.env);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.token);
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    };
  }

  /**
   * Create a pull request linked to an issue.
   * Enforces fail-closed allow-listing via DF_WORKER_ALLOWED_REPOS.
   */
  async createPullRequest(
    owner: string,
    repo: string,
    options: CreatePullRequestOptions,
  ): Promise<CreatePullRequestResult> {
    const validNamePattern = /^[a-zA-Z0-9_.-]+$/;
    if (!validNamePattern.test(owner) || !validNamePattern.test(repo)) {
      return {
        ok: false,
        error: `Invalid repository owner '${owner}' or name '${repo}'. Allowed characters are alphanumeric, hyphen, underscore, and dot.`,
      };
    }

    const fullRepo = `${owner}/${repo}`.toLowerCase();
    const allowedRepos = resolveWorkerAllowedRepos(this.env);

    if (allowedRepos.length === 0) {
      return {
        ok: false,
        error:
          "DF_WORKER_ALLOWED_REPOS is not configured; refusing to open PR (fail-closed).",
      };
    }

    if (!allowedRepos.includes(fullRepo)) {
      return {
        ok: false,
        error: `repo '${fullRepo}' is not in DF_WORKER_ALLOWED_REPOS.`,
      };
    }

    if (!this.token) {
      return {
        ok: false,
        error:
          "No GitHub token configured (GH_STORY_TOKEN / GH_RELEASE_TOKEN / GITHUB_TOKEN). Refusing to open PR.",
      };
    }

    const base = options.base || "main";
    let body = options.body.trim();
    const issueLink = `Closes #${options.issue}`;
    if (!body.includes(issueLink) && !options.title.includes(issueLink)) {
      body = body ? `${body}\n\n${issueLink}` : issueLink;
    }

    try {
      const res = await this.fetchImpl(
        `${this.apiBase}/repos/${owner}/${repo}/pulls`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            title: options.title,
            head: options.head,
            // #739: draft - the target's e2e is still running, so this is not a merge proposal.
            draft: true,
            base,
            body,
          }),
        },
      );

      if (!res.ok) {
        // Surface WHAT GitHub said. A bare status code turned a diagnosable payload problem into a
        // mystery: the difference between "this already exists" and "your request is malformed" is
        // in the body, and without it the operator has a number and no cause.
        const detail = await res.text().catch(() => "");
        const suffix = detail ? ": " + detail.replace(/\s+/g, " ").slice(0, 300) : "";

        if (res.status === 422) {
          // #754: creating a resource that already exists is a SUCCESS that returns it. GitHub answers
          // 422 to a create for an existing head, and treating that as a failure refused the Definition
          // of Done on a re-run whose only sin was finding its own pull request open.
          const headQuery = options.head.includes(":")
            ? options.head
            : owner + ":" + options.head;
          const lookup = await this.fetchImpl(
            `${this.apiBase}/repos/${owner}/${repo}/pulls?head=${headQuery}&state=open`,
            { method: "GET", headers: this.headers() },
          );
          if (lookup.ok) {
            const found = (await lookup.json()) as Array<{
              number?: number;
              html_url?: string;
              title?: string;
              body?: string;
              head?: { ref?: string };
              base?: { ref?: string };
            }>;
            const existing = Array.isArray(found) ? found[0] : undefined;
            // Forgiven ONLY once the lookup proves the pull request exists: a 422 with nothing behind
            // it is still a failure, which is what the control case pins.
            if (existing && typeof existing.number === "number") {
              return {
                ok: true,
                status: res.status,
                pr: {
                  number: existing.number,
                  url: existing.html_url ?? "",
                  head: existing.head?.ref ?? options.head,
                  base: existing.base?.ref ?? base,
                  title: existing.title ?? options.title,
                  body: existing.body ?? options.body,
                },
              };
            }
          }
        }

        return {
          ok: false,
          status: res.status,
          error: `GitHub responded ${res.status}${suffix}`,
        };
      }

      const data = (await res.json()) as { number: number; html_url: string };
      return {
        ok: true,
        status: res.status,
        pr: {
          number: data.number,
          url: data.html_url,
          head: options.head,
          base,
          title: options.title,
          body,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }
}
