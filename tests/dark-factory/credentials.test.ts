import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  toRepoGrant,
  isExpired,
  InvalidGrantError,
  MAX_TTL_SECONDS,
  ConsoleCredentialBroker,
  LocalCredentialBroker,
  createCredentialBroker,
  listenCredentialEndpoint,
  type Lease,
} from "../../agent/lib/dark-factory/credentials";

const lease = (over: Partial<Lease> = {}): Lease => ({
  leaseId: "lease-1",
  repos: ["ricardoblackskye/agent-eve"],
  issuedAt: 1_000,
  expiresAt: 1_600,
  ...over,
});

describe("RepoGrant canonical shape (#142 AC1)", () => {
  it("normalises to lowercase owner/repo and dedupes", () => {
    const grant = toRepoGrant({
      repos: [
        "RicardoBlackSkye/Agent-Eve",
        "ricardoblackskye/agent-eve",
        "  ricardoblackskye/WebFeedPOC  ",
      ],
      ttlSeconds: 600,
    });

    expect(grant.repos).toEqual([
      "ricardoblackskye/agent-eve",
      "ricardoblackskye/webfeedpoc",
    ]);
    expect(grant.ttlSeconds).toBe(600);
  });

  it("defaults the TTL to the 60-minute maximum when omitted", () => {
    expect(toRepoGrant({ repos: ["owner/repo"] }).ttlSeconds).toBe(MAX_TTL_SECONDS);
  });

  it("rejects an empty or blank-only repo list, naming the field", () => {
    expect(() => toRepoGrant({ repos: [] })).toThrow(InvalidGrantError);
    expect(() => toRepoGrant({ repos: ["   "] })).toThrow(/repos/);
  });

  it("rejects a TTL above the 60-minute maximum, naming the limit", () => {
    expect(() => toRepoGrant({ repos: ["owner/repo"], ttlSeconds: MAX_TTL_SECONDS + 1 })).toThrow(
      InvalidGrantError,
    );
    expect(() => toRepoGrant({ repos: ["owner/repo"], ttlSeconds: MAX_TTL_SECONDS + 1 })).toThrow(
      /3600/,
    );
  });

  it("rejects a non-positive TTL", () => {
    expect(() => toRepoGrant({ repos: ["owner/repo"], ttlSeconds: 0 })).toThrow(/ttl/i);
    expect(() => toRepoGrant({ repos: ["owner/repo"], ttlSeconds: -5 })).toThrow(/ttl/i);
  });

  it("rejects an identifier that is not an owner/repo pair", () => {
    expect(() => toRepoGrant({ repos: ["agent-eve"] })).toThrow(/owner\/repo/);
  });
});

describe("isExpired — pure, clock-injected (#142 AC3)", () => {
  it("is false before the expiry instant", () => {
    expect(isExpired(lease(), 1_599)).toBe(false);
  });

  it("is true at exactly the expiry instant and after", () => {
    expect(isExpired(lease(), 1_600)).toBe(true);
    expect(isExpired(lease(), 1_601)).toBe(true);
  });
});

describe("fail-closed default broker (#142 AC4)", () => {
  it("refuses to issue a lease when no token is configured", async () => {
    const broker = new ConsoleCredentialBroker();

    const res = await broker.issue(toRepoGrant({ repos: ["owner/repo"] }));

    expect(res.ok).toBe(false);
    expect(res.mode).toBe("blocked");
    expect(res.lease).toBeUndefined();
    expect(res.error).toMatch(/not configured/i);
    expect(broker.mode).toBe("blocked");
  });

  it("denies every adjudication with 401, so nothing is silently permitted", async () => {
    const res = await new ConsoleCredentialBroker().authorize("lease-x", "owner/repo");

    expect(res.status).toBe(401);
  });
});

describe("LocalCredentialBroker — issuance keeps the token inside (#142 AC1/AC4)", () => {
  const TOKEN = "ghp_SUPERSECRET_TOKEN_VALUE";
  const makeBroker = () => new LocalCredentialBroker({ token: TOKEN, now: () => 1_000 });

  it("issues an opaque lease scoped to the granted repos with a bounded TTL", async () => {
    const res = await makeBroker().issue(
      toRepoGrant({ repos: ["ricardoblackskye/agent-eve"], ttlSeconds: 600 }),
    );

    expect(res.ok).toBe(true);
    expect(res.mode).toBe("live");
    expect(res.lease?.repos).toEqual(["ricardoblackskye/agent-eve"]);
    expect(res.lease?.issuedAt).toBe(1_000);
    // ttlSeconds is SECONDS: 600s => 600_000ms after issue.
    expect(res.lease?.expiresAt).toBe(601_000);
    expect(res.lease?.leaseId).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  });

  it("mints a distinct lease per task", async () => {
    const broker = makeBroker();
    const grant = toRepoGrant({ repos: ["ricardoblackskye/agent-eve"] });

    const a = await broker.issue(grant);
    const b = await broker.issue(grant);

    expect(a.lease?.leaseId).not.toBe(b.lease?.leaseId);
  });

  it("never embeds the token in the lease or any returned value (AC4)", async () => {
    const res = await makeBroker().issue(toRepoGrant({ repos: ["ricardoblackskye/agent-eve"] }));

    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(JSON.stringify(res.lease)).not.toContain(TOKEN);
    expect(res.lease?.leaseId).not.toBe(TOKEN);
  });
});

describe("allow-list enforcement (#142 AC2)", () => {
  const TOKEN = "ghp_SUPERSECRET_TOKEN_VALUE";

  const withLease = async () => {
    const broker = new LocalCredentialBroker({ token: TOKEN, now: () => 1_000 });
    const issued = await broker.issue(
      toRepoGrant({ repos: ["ricardoblackskye/agent-eve"], ttlSeconds: 60 }),
    );
    return { broker, leaseId: (issued.lease as Lease).leaseId };
  };

  it("permits the allow-listed repo", async () => {
    const { broker, leaseId } = await withLease();

    expect((await broker.authorize(leaseId, "ricardoblackskye/agent-eve")).status).toBe(200);
  });

  it("rejects any other repo with 403 and performs no work", async () => {
    const { broker, leaseId } = await withLease();
    const writes: string[] = [];
    const writeTo = (repo: string): void => {
      writes.push(repo);
    };

    const res = await broker.authorize(leaseId, "ricardoblackskye/other-repo");
    if (res.status === 200) writeTo("ricardoblackskye/other-repo");

    expect(res.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it("compares repo identifiers case-insensitively", async () => {
    const { broker, leaseId } = await withLease();

    expect((await broker.authorize(leaseId, "RicardoBlackSkye/Agent-Eve")).status).toBe(200);
  });
});

describe("TTL expiry and revocation (#142 AC3)", () => {
  const TOKEN = "ghp_SUPERSECRET_TOKEN_VALUE";
  const REPO = "ricardoblackskye/agent-eve";

  it("returns 401 once the lease has expired", async () => {
    let clock = 1_000;
    const broker = new LocalCredentialBroker({ token: TOKEN, now: () => clock });
    const issued = await broker.issue(toRepoGrant({ repos: [REPO], ttlSeconds: 60 }));
    const lease = issued.lease as Lease;

    expect((await broker.authorize(lease.leaseId, REPO)).status).toBe(200);

    clock = lease.expiresAt; // exactly at expiry
    expect((await broker.authorize(lease.leaseId, REPO)).status).toBe(401);
  });

  it("returns 401 immediately after revocation, and revoke is idempotent", async () => {
    const broker = new LocalCredentialBroker({ token: TOKEN, now: () => 1_000 });
    const issued = await broker.issue(toRepoGrant({ repos: [REPO] }));
    const leaseId = (issued.lease as Lease).leaseId;

    expect((await broker.revoke(leaseId)).ok).toBe(true);
    expect((await broker.authorize(leaseId, REPO)).status).toBe(401);
    expect((await broker.revoke(leaseId)).ok).toBe(true);
    expect((await broker.revoke("never-existed")).ok).toBe(true);
  });

  it("returns 401 for a lease id the broker never issued", async () => {
    const broker = new LocalCredentialBroker({ token: TOKEN });

    expect((await broker.authorize("forged-lease", REPO)).status).toBe(401);
  });
});

describe("createCredentialBroker env wiring (#142)", () => {
  const SECRET = "ghp_SUPERSECRET_TOKEN_VALUE";

  it("is fail-closed when no token is configured", () => {
    const broker = createCredentialBroker({});

    expect(broker.id).toBe("console");
    expect(broker.mode).toBe("blocked");
  });

  it("treats a whitespace-only token as unconfigured", () => {
    expect(createCredentialBroker({ GITHUB_TOKEN: "   " }).mode).toBe("blocked");
  });

  it("returns the local broker when a token is present", () => {
    expect(createCredentialBroker({ GITHUB_TOKEN: SECRET }).id).toBe("local");
  });

  it("resolves GH_STORY_TOKEN, then GH_RELEASE_TOKEN, then GITHUB_TOKEN", () => {
    const all = createCredentialBroker({
      GH_STORY_TOKEN: "story",
      GH_RELEASE_TOKEN: "release",
      GITHUB_TOKEN: "generic",
    }) as LocalCredentialBroker;
    expect(all.tokenSource).toBe("GH_STORY_TOKEN");

    const noStory = createCredentialBroker({
      GH_RELEASE_TOKEN: "release",
      GITHUB_TOKEN: "generic",
    }) as LocalCredentialBroker;
    expect(noStory.tokenSource).toBe("GH_RELEASE_TOKEN");

    const genericOnly = createCredentialBroker({ GITHUB_TOKEN: "generic" }) as LocalCredentialBroker;
    expect(genericOnly.tokenSource).toBe("GITHUB_TOKEN");
  });

  it("does not leak the token through property enumeration or JSON", () => {
    const broker = createCredentialBroker({ GITHUB_TOKEN: SECRET });

    expect(JSON.stringify(broker)).not.toContain(SECRET);
    expect(Object.keys(broker)).not.toContain("token");
  });
});

describe("HTTP adjudication endpoint (#142 AC2/AC3 over a real socket)", () => {
  const SECRET = "ghp_SUPERSECRET_TOKEN_VALUE";
  const REPO = "ricardoblackskye/agent-eve";
  let broker: LocalCredentialBroker;
  let listener!: { url: string; close: () => Promise<void> };
  let leaseId: string;
  let responses: string[] = [];

  beforeEach(async () => {
    broker = new LocalCredentialBroker({ token: SECRET, now: () => 1_000 });
    const issued = await broker.issue(toRepoGrant({ repos: [REPO], ttlSeconds: 60 }));
    leaseId = (issued.lease as Lease).leaseId;
    listener = await listenCredentialEndpoint(broker, { port: 0 });
    responses = [];
  });

  afterEach(async () => {
    await listener.close();
  });

  const call = async (path: string, body: unknown, lease?: string) => {
    const res = await fetch(`${listener.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(lease ? { authorization: `Bearer ${lease}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    responses.push(text);
    return { status: res.status, text, json: text ? JSON.parse(text) : {} };
  };

  it("returns 200 for the allow-listed repo", async () => {
    expect((await call("/authorize", { repo: REPO }, leaseId)).status).toBe(200);
  });

  it("returns 403 for a repo outside the lease", async () => {
    expect((await call("/authorize", { repo: "ricardoblackskye/other-repo" }, leaseId)).status).toBe(
      403,
    );
  });

  it("returns 401 with no lease, a forged lease, or a revoked lease", async () => {
    expect((await call("/authorize", { repo: REPO })).status).toBe(401);
    expect((await call("/authorize", { repo: REPO }, "forged-lease")).status).toBe(401);

    await broker.revoke(leaseId);
    expect((await call("/authorize", { repo: REPO }, leaseId)).status).toBe(401);
  });

  it("returns 400 for a malformed body", async () => {
    expect((await call("/authorize", { repo: 42 }, leaseId)).status).toBe(400);
    expect((await call("/authorize", "not-an-object", leaseId)).status).toBe(400);
  });

  it("does NOT expose lease issuance over HTTP", async () => {
    const res = await call("/lease", { repos: [REPO], ttlSeconds: 60 }, leaseId);

    expect(res.status).toBe(404);
    expect(res.json.lease).toBeUndefined();
  });

  it("never puts the token in any response", async () => {
    await call("/authorize", { repo: REPO }, leaseId);
    await call("/authorize", { repo: "other/repo" }, leaseId);
    await call("/authorize", { repo: REPO }, "forged-lease");

    expect(responses).toHaveLength(3);
    for (const text of responses) expect(text).not.toContain(SECRET);
  });
});