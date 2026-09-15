import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

/**
 * Dark Factory — Credential ingress / worker privilege boundary (issues #141 / story #142).
 *
 * A BROKER, not a token dispenser: it holds the operator's token, mints opaque
 * short-lived leases (handle + TTL + repo allow-list) and adjudicates every
 * worker access request. The token is never handed to a sandbox — which is what
 * makes #142 AC4 ("MUST NOT deliver a broad long-lived PAT to any worker
 * sandbox") true by construction rather than by policy.
 *
 * R2 scope: this is the policy/adjudication seam. It performs NO GitHub API call
 * itself — the concrete privileged operation that consumes the token is wired by
 * the R3 worker. `mode: "live"` therefore means "a token is configured and leases
 * may be issued", not "GitHub has been contacted".
 */

/** The longest lease we will mint, per #142 AC1 ("TTL of at most 60 minutes"). */
export const MAX_TTL_SECONDS = 3600;

/**
 * Canonical grant: which repos a worker task may touch, and for how long.
 * Provider-agnostic — no token material travels in it.
 */
export interface RepoGrant {
  /** Normalised, lowercased `owner/repo` entries. */
  repos: string[];
  /** Lease lifetime in seconds; never above `MAX_TTL_SECONDS`. */
  ttlSeconds: number;
}

/** What the sandbox holds: an opaque handle, a repo list, and an expiry. */
export interface Lease {
  leaseId: string;
  repos: string[];
  issuedAt: number;
  expiresAt: number;
}

export type AuthorizeResult =
  | { status: 200; leaseId: string; repo: string }
  | { status: 403; reason: string }
  | { status: 401; reason: string };

export class InvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGrantError";
  }
}

/**
 * `owner/repo` restricted to what GitHub actually allows. Owner: alphanumerics
 * and single internal hyphens (no leading/trailing hyphen, no `--`). Repo:
 * alphanumerics plus `-`, `_`, `.`. Shared with worker-env. This is the intake
 * filter — rejecting here gives precise operator feedback instead of a late
 * failure when the broker uses the token.
 */
export const REPO_PAIR_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\/[A-Za-z0-9_.-]+$/;

/**
 * Normalise a grant. Repos are lowercased and deduped for comparison (GitHub
 * owners and repos are case-insensitive), blank entries are dropped, and a
 * malformed pair or an over-long/non-positive TTL is REJECTED rather than
 * silently clamped — an operator asking for a 2-hour lease should be told the
 * boundary, not quietly given 60 minutes.
 */
export function toRepoGrant(input: {
  repos?: string[];
  ttlSeconds?: number;
}): RepoGrant {
  const raw = Array.isArray(input.repos) ? input.repos : [];
  const cleaned: string[] = [];

  for (const entry of raw) {
    const value = typeof entry === "string" ? entry.trim() : "";
    if (value === "") continue;
    if (!REPO_PAIR_PATTERN.test(value)) {
      throw new InvalidGrantError(
        `Repo grant entry ${JSON.stringify(entry)} is not an owner/repo pair.`,
      );
    }
    cleaned.push(value.toLowerCase());
  }

  const repos = [...new Set(cleaned)];
  if (repos.length === 0) {
    throw new InvalidGrantError(
      'Repo grant requires a non-empty "repos" list of owner/repo entries.',
    );
  }

  const ttlSeconds = input.ttlSeconds ?? MAX_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new InvalidGrantError(
      `Repo grant "ttlSeconds" must be a positive integer (received ${JSON.stringify(input.ttlSeconds)}).`,
    );
  }
  if (ttlSeconds > MAX_TTL_SECONDS) {
    throw new InvalidGrantError(
      `Repo grant "ttlSeconds" must be at most ${MAX_TTL_SECONDS} (60 minutes); received ${ttlSeconds}.`,
    );
  }

  return { repos, ttlSeconds };
}

/**
 * Pure expiry check — the clock is injected so tests never sleep. A lease is
 * expired AT its expiry instant: `expiresAt` is the first moment it is no
 * longer valid.
 */
export function isExpired(lease: Lease, now: number): boolean {
  return now >= lease.expiresAt;
}

// ---------------------------------------------------------------------------
// CredentialBroker seam
// ---------------------------------------------------------------------------

export interface IssueResult {
  ok: boolean;
  mode: "live" | "blocked";
  lease?: Lease;
  error?: string;
}

export interface RevokeResult {
  ok: boolean;
  error?: string;
}

/**
 * Holds the operator's token and adjudicates every worker access request.
 *
 * `issue` is IN-PROCESS ONLY and is deliberately never exposed over HTTP: a
 * worker must not be able to mint its own lease. `authorize` is the operation a
 * sandbox is allowed to perform, so it is the one the HTTP endpoint fronts.
 */
export interface CredentialBroker {
  id: string;
  mode: "live" | "blocked";
  issue(grant: RepoGrant): Promise<IssueResult>;
  authorize(leaseId: string, repo: string): Promise<AuthorizeResult>;
  revoke(leaseId: string): Promise<RevokeResult>;
}

/** Shared refusal text for the fail-closed default. */
const CREDENTIALS_NOT_CONFIGURED =
  "Repository token is not configured (set GH_STORY_TOKEN, GH_RELEASE_TOKEN or GITHUB_TOKEN).";

/**
 * Fail-closed default: refuses to issue any lease and denies every request, so
 * an unconfigured deployment cannot hand a worker anything at all.
 */
export class ConsoleCredentialBroker implements CredentialBroker {
  id = "console";
  mode: "live" | "blocked" = "blocked";

  async issue(grant: RepoGrant): Promise<IssueResult> {
    void grant;
    return {
      ok: false,
      mode: "blocked",
      error: `${CREDENTIALS_NOT_CONFIGURED} Refusing to issue a worker lease.`,
    };
  }

  async authorize(leaseId: string, repo: string): Promise<AuthorizeResult> {
    void repo;
    return {
      status: 401,
      reason: `${CREDENTIALS_NOT_CONFIGURED} No lease '${leaseId}' can be valid.`,
    };
  }

  async revoke(leaseId: string): Promise<RevokeResult> {
    void leaseId;
    return { ok: false, error: CREDENTIALS_NOT_CONFIGURED };
  }
}

export interface LocalBrokerOptions {
  /** The operator's token. Held here and NEVER handed to a worker. */
  token: string;
  /** NAME of the env var the token came from (never the value) — for observability. */
  tokenSource?: string;
  /** Injected clock (ms). */
  now?: () => number;
  /** Injected lease-id minter, so tests are deterministic. */
  mintLeaseId?: () => string;
  /**
   * Global `DF_WORKER_ALLOWED_REPOS` policy (normalised `owner/repo`). When
   * provided, `issue` refuses any grant containing a repo outside it —
   * defence in depth, so the allow-list is a property of the credential
   * boundary and not only of the worker handler. Fail-closed: an empty list
   * refuses every grant. Omit to skip the global gate (direct construction).
   */
  allowedRepos?: string[];
}

/**
 * The working broker: holds the token, mints opaque leases, adjudicates.
 *
 * The worker receives a lease id only. Every privileged action stays here, which
 * is what makes #142 AC4 ("MUST NOT deliver a broad long-lived PAT to any worker
 * sandbox") true by construction rather than by policy.
 */
export class LocalCredentialBroker implements CredentialBroker {
  id = "local";
  /** Which env var the token came from — the name only, never the value. */
  readonly tokenSource: string;
  /**
   * A real ECMAScript private field, not just a TS `private`: the token cannot
   * be reached by property enumeration, `JSON.stringify`, or a spread, so an
   * accidental debug dump or error serializer cannot leak it.
   */
  readonly #token: string;
  private readonly now: () => number;
  private readonly mintLeaseId: () => string;
  /**
   * Global allow-list, or `undefined` when the caller opted out (direct
   * construction). Normalised lowercase by the resolver.
   */
  private readonly allowedRepos?: string[];
  private readonly leases = new Map<
    string,
    { repos: string[]; issuedAt: number; expiresAt: number; revoked: boolean }
  >();

  constructor(options: LocalBrokerOptions) {
    this.#token = options.token;
    this.tokenSource = options.tokenSource ?? "unknown";
    this.now = options.now ?? (() => Date.now());
    this.mintLeaseId = options.mintLeaseId ?? (() => randomUUID());
    this.allowedRepos = options.allowedRepos;
  }

  get mode(): "live" | "blocked" {
    return this.#token ? "live" : "blocked";
  }

  /** Leases currently tracked (observability only; never exposes the token). */
  get size(): number {
    return this.leases.size;
  }

  /**
   * Bound memory: drop leases that can never authorise again — expired or
   * revoked. Called on every `issue`, so a long-lived broker's map tracks only
   * leases that are still live and cannot grow without bound. (A `setInterval`
   * timer is deliberately avoided: this module runs in a serverless deployment
   * where a live timer would keep the process awake.)
   */
  private pruneDead(now: number): void {
    for (const [id, entry] of this.leases) {
      if (entry.revoked || now >= entry.expiresAt) this.leases.delete(id);
    }
  }

  async issue(grant: RepoGrant): Promise<IssueResult> {
    if (!this.#token) {
      return {
        ok: false,
        mode: "blocked",
        error: `${CREDENTIALS_NOT_CONFIGURED} Refusing to issue a worker lease.`,
      };
    }

    // Defence in depth: the GLOBAL worker allow-list is enforced here too, not
    // only at the worker handler, so a caller that reaches the broker directly
    // still cannot obtain a lease for a repo the operator never allowed.
    // Fail-closed: an empty list refuses every grant.
    if (this.allowedRepos) {
      const outside = grant.repos.filter((repo) => !this.allowedRepos!.includes(repo));
      if (outside.length > 0) {
        return {
          ok: false,
          mode: "blocked",
          error:
            `Repo(s) ${outside.join(", ")} are not in DF_WORKER_ALLOWED_REPOS ` +
            `[${this.allowedRepos.join(", ")}]. Refusing to issue a worker lease.`,
        };
      }
    }

    const issuedAt = this.now();
    // Evict dead leases before adding a new one, so the map stays bounded.
    this.pruneDead(issuedAt);
    const lease: Lease = {
      leaseId: this.mintLeaseId(),
      repos: [...grant.repos],
      issuedAt,
      expiresAt: issuedAt + grant.ttlSeconds * 1000,
    };
    // The token is deliberately absent from the lease and from anything the
    // caller receives: the sandbox holds an opaque id, nothing more.
    this.leases.set(lease.leaseId, {
      repos: lease.repos,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      revoked: false,
    });
    return { ok: true, mode: "live", lease };
  }

  async authorize(leaseId: string, repo: string): Promise<AuthorizeResult> {
    const entry = this.leases.get(leaseId);
    if (!entry) {
      return { status: 401, reason: `Lease '${leaseId}' is not known to this broker.` };
    }
    if (entry.revoked) {
      return { status: 401, reason: `Lease '${leaseId}' was revoked.` };
    }
    if (this.now() >= entry.expiresAt) {
      return { status: 401, reason: `Lease '${leaseId}' expired at ${entry.expiresAt}.` };
    }

    const target = typeof repo === "string" ? repo.trim().toLowerCase() : "";
    if (!entry.repos.includes(target)) {
      return {
        status: 403,
        reason: `'${target}' is not one of the repos allow-listed for this lease.`,
      };
    }
    return { status: 200, leaseId, repo: target };
  }

  async revoke(leaseId: string): Promise<RevokeResult> {
    const entry = this.leases.get(leaseId);
    // Idempotent, mirroring the repo's "404-as-success" label rule: revoking a
    // lease that is unknown or already revoked is a no-op, not an error.
    if (!entry) return { ok: true };
    entry.revoked = true;
    return { ok: true };
  }
}

/**
 * Token resolution order. Mirrors `githubConfiguredToken()` in
 * `backlog-provider.ts` so a worker and the Product Owner never resolve
 * DIFFERENT credentials from the same environment — a divergence here would be
 * a security-relevant bug, not just an inconsistency. (A follow-up can hoist a
 * single shared helper once R1's module is under test for it.)
 */
const TOKEN_SOURCES = ["GH_STORY_TOKEN", "GH_RELEASE_TOKEN", "GITHUB_TOKEN"] as const;

export function resolveRepoToken(
  env: Record<string, string | undefined> = process.env,
): { token: string; source: string } | null {
  for (const name of TOKEN_SOURCES) {
    const value = (env[name] || "").trim();
    if (value) return { token: value, source: name };
  }
  return null;
}

/**
 * Reads `DF_WORKER_ALLOWED_REPOS` (comma-separated `owner/repo`).
 *
 * Fail-closed: an unset/blank list yields `[]`, which makes BOTH `withWorker`
 * (worker-env) and `LocalCredentialBroker.issue` refuse every task/repo — an
 * unconfigured deployment can provision nothing, matching the
 * `STORY_ALLOWED_REPOS` stance. Lives here (next to the repo-pair pattern and
 * the broker that enforces it); worker-env re-exports it for its own callers.
 */
export function resolveWorkerAllowedRepos(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = (env.DF_WORKER_ALLOWED_REPOS || "").trim();
  if (raw === "") return [];

  const repos: string[] = [];
  for (const entry of raw.split(",")) {
    const value = entry.trim().toLowerCase();
    if (value === "") continue;
    if (!REPO_PAIR_PATTERN.test(value)) {
      throw new Error(
        `DF_WORKER_ALLOWED_REPOS entry ${JSON.stringify(entry)} is not an owner/repo pair.`,
      );
    }
    repos.push(value);
  }
  return [...new Set(repos)];
}

/** Fail-closed factory: no token anywhere -> the refusing console broker. */
export function createCredentialBroker(
  env: Record<string, string | undefined> = process.env,
): CredentialBroker {
  const resolved = resolveRepoToken(env);
  if (!resolved) return new ConsoleCredentialBroker();
  return new LocalCredentialBroker({
    token: resolved.token,
    tokenSource: resolved.source,
    // The global allow-list is a property of the credential boundary, so the
    // broker enforces it too — not only the worker handler (defence in depth).
    allowedRepos: resolveWorkerAllowedRepos(env),
  });
}

// ---------------------------------------------------------------------------
// HTTP adjudication endpoint
//
// ADJUDICATION ONLY. Lease issuance is deliberately absent from the routing
// table: a sandbox must never be able to mint its own credential, so that
// operation stays reachable only in-process (the orchestrator's own code path).
// ---------------------------------------------------------------------------

export interface CredentialEndpointRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface CredentialEndpointResponse {
  status: number;
  body: Record<string, unknown>;
}

export type CredentialEndpoint = (
  request: CredentialEndpointRequest,
) => Promise<CredentialEndpointResponse>;

function findHeader(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

export function createCredentialEndpoint(broker: CredentialBroker): CredentialEndpoint {
  return async (request) => {
    const path = (request.path || "").split("?")[0];

    // Only adjudication is routed. `/lease` is intentionally absent: a sandbox
    // must not be able to mint its own credential.
    if (path !== "/authorize") {
      return { status: 404, body: { error: "not_found", reason: `No route for '${path}'.` } };
    }
    if ((request.method || "").toUpperCase() !== "POST") {
      return { status: 405, body: { error: "method_not_allowed" } };
    }

    const header = findHeader(request.headers, "authorization");
    const leaseId =
      header && header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!leaseId) {
      return { status: 401, body: { error: "unauthorized", reason: "Missing bearer lease." } };
    }

    const body = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return {
        status: 400,
        body: { error: "bad_request", reason: "Body must be a JSON object." },
      };
    }
    const repo = (body as Record<string, unknown>).repo;
    if (typeof repo !== "string" || repo.trim() === "") {
      return {
        status: 400,
        body: { error: "bad_request", reason: '"repo" must be a non-empty string.' },
      };
    }

    const result = await broker.authorize(leaseId, repo);
    if (result.status === 200) {
      return { status: 200, body: { status: 200, leaseId: result.leaseId, repo: result.repo } };
    }
    return { status: result.status, body: { status: result.status, reason: result.reason } };
  };
}

/**
 * Bind the endpoint to a real socket, loopback by default. R2 uses this for the
 * in-process sandbox and to prove the AC's HTTP semantics over the wire; R3 can
 * mount the same handler as a Next route once a remote sandbox must call back.
 */
export async function listenCredentialEndpoint(
  broker: CredentialBroker,
  options: { host?: string; port?: number } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const handle = createCredentialEndpoint(broker);

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      handle({
        method: req.method || "",
        path: req.url || "",
        headers: req.headers as Record<string, string | undefined>,
        body,
      })
        .then((out) => {
          res.writeHead(out.status, { "content-type": "application/json" });
          res.end(JSON.stringify(out.body));
        })
        .catch(() => {
          // Never surface an internals leak: the broker's failures are already
          // expressed as statuses, so anything reaching here is unexpected.
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal_error" }));
        });
    });
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}