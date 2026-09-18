/**
 * Dark Factory — the GitHub primitives the orchestrator needs to speak on a
 * ticket: post a comment, edit a comment, add a label, remove a label (#162).
 *
 * Why these live here rather than being called from the story provider:
 * `backlog-provider.ts`'s `GitHubProvider` already does all four inline, but
 * `BacklogProvider` exposes only `publish(payload)`. Refactoring merged,
 * fail-closed story-publish code is not this issue's business, so the reporter
 * gets its own small, token-injected set of primitives — and `backlog-provider`
 * can adopt them later.
 *
 * Two behaviours are copied deliberately from `GitHubProvider` rather than
 * rediscovered:
 *   - the token is resolved and used HERE, in the orchestrator's process; it is
 *     never passed to a worker task (#142);
 *   - removing a label that is already absent (404) is SUCCESS, not a warning,
 *     so a retry cannot pile up spurious errors.
 */
export type IssueWriterFetch = typeof fetch;

export interface WriteResult {
  ok: boolean;
  /** HTTP status when a call was made. */
  status?: number;
  /** Comment id, for the calls that create one. */
  id?: number;
  error?: string;
}

/**
 * The orchestrator's token, resolved the same way `backlog-provider` resolves it
 * so one deployment only needs one of these set. Returns `undefined` when none
 * is configured — callers must treat that as "cannot write", never as "write
 * without auth".
 */
export function resolveIssueToken(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.GH_STORY_TOKEN || env.GH_RELEASE_TOKEN || env.GITHUB_TOKEN;
}

export interface GitHubIssueWriterOptions {
  token?: string;
  /**
   * Injected transport (tests supply a fake). Deliberately the ONLY way to
   * redirect calls: an overridable API base is a hazard with no production
   * caller — point it at another host and the token is sent there — so it does
   * not exist. A test that needs a different host supplies its own `fetchImpl`.
   */
  fetchImpl?: IssueWriterFetch;
}

/**
 * Adapt the GitHub primitives to the `LabelWriter` seam the entry point needs (#163),
 * so the trigger can move lifecycle labels without knowing what a GitHub is.
 */
export function createGitHubLabelWriter(writer?: GitHubIssueWriter): {
  add(
    repo: string,
    issue: number,
    label: string,
  ): Promise<{ ok: boolean; error?: string }>;
  remove(
    repo: string,
    issue: number,
    label: string,
  ): Promise<{ ok: boolean; error?: string }>;
} {
  const github = writer ?? new GitHubIssueWriter();
  const split = (repo: string): [string, string] => {
    const [owner, name] = repo.split("/");
    return [owner ?? "", name ?? ""];
  };
  return {
    async add(repo, issue, label) {
      const [owner, name] = split(repo);
      const res = await github.addLabel(owner, name, issue, label);
      return { ok: res.ok, error: res.error };
    },
    async remove(repo, issue, label) {
      const [owner, name] = split(repo);
      const res = await github.removeLabel(owner, name, issue, label);
      return { ok: res.ok, error: res.error };
    },
  };
}

export class GitHubIssueWriter {
  private readonly token?: string;
  private readonly fetchImpl: IssueWriterFetch;
  private readonly apiBase = "https://api.github.com";

  constructor(options: GitHubIssueWriterOptions = {}) {
    this.token = options.token ?? resolveIssueToken();
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

  private async call(
    url: string,
    method: string,
    body?: unknown,
  ): Promise<WriteResult> {
    if (!this.token) {
      return {
        ok: false,
        error:
          "No GitHub token configured (GH_STORY_TOKEN / GH_RELEASE_TOKEN / GITHUB_TOKEN). " +
          "Refusing to write.",
      };
    }
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: `GitHub responded ${res.status}`,
        };
      }
      const parsed = (await res.json().catch(() => ({}))) as { id?: number };
      return { ok: true, status: res.status, id: parsed.id };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /** POST a new issue comment. */
  async postComment(
    owner: string,
    repo: string,
    issue: number,
    body: string,
  ): Promise<WriteResult> {
    return this.call(
      `${this.apiBase}/repos/${owner}/${repo}/issues/${issue}/comments`,
      "POST",
      {
        body,
      },
    );
  }

  /** PATCH an existing comment — the edit half of idempotence. */
  async editComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
  ): Promise<WriteResult> {
    return this.call(
      `${this.apiBase}/repos/${owner}/${repo}/issues/comments/${commentId}`,
      "PATCH",
      {
        body,
      },
    );
  }

  async addLabel(
    owner: string,
    repo: string,
    issue: number,
    label: string,
  ): Promise<WriteResult> {
    return this.call(
      `${this.apiBase}/repos/${owner}/${repo}/issues/${issue}/labels`,
      "POST",
      {
        labels: [label],
      },
    );
  }

  /**
   * Remove a label. An already-absent label (404) is SUCCESS — the post-state is
   * what was asked for, and treating it as an error would make a retry noisy.
   */
  async removeLabel(
    owner: string,
    repo: string,
    issue: number,
    label: string,
  ): Promise<WriteResult> {
    const res = await this.call(
      `${this.apiBase}/repos/${owner}/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`,
      "DELETE",
    );
    if (!res.ok && res.status === 404) return { ok: true, status: 404 };
    return res;
  }
}
