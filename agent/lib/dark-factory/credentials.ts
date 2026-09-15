import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

/**
 * Dark Factory — Credential ingress / worker privilege boundary (issues #141 / story #142).
 *
 * STUB — implementation pending (TDD RED).
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

/** `owner/repo`, with no whitespace or extra separators. */
const REPO_PAIR = /^[^/\s]+\/[^/\s]+$/;

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
    if (!REPO_PAIR.test(value)) {
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
  private readonly leases = new Map<
    string,
    { repos: string[]; issuedAt: number; expiresAt: number; revoked: boolean }
  >();

  constructor(options: LocalBrokerOptions) {
    this.#token = options.token;
    this.tokenSource = options.tokenSource ?? "unknown";
    this.now = options.now ?? (() => Date.now());
    this.mintLeaseId = options.mintLeaseId ?? (() => randomUUID());
  }

  get mode(): "live" | "blocked" {
    return this.#token ? "live" : "blocked";
  }

  async issue(grant: RepoGrant): Promise<IssueResult> {
    if (!this.#token) {
      return {
        ok: false,
        mode: "blocked",
        error: `${CREDENTIALS_NOT_CONFIGURED} Refusing to issue a worker lease.`,
      };
    }

    const issuedAt = this.now();
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

/** Fail-closed factory: no token anywhere -> the refusing console broker. */
export function createCredentialBroker(
  env: Record<string, string | undefined> = process.env,
): CredentialBroker {
  const resolved = resolveRepoToken(env);
  if (!resolved) return new ConsoleCredentialBroker();
  return new LocalCredentialBroker({ token: resolved.token, tokenSource: resolved.source });
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