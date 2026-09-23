import { describe, it, expect } from "vitest";
import {
  SESSION_COOKIE_NAME,
  DEFAULT_SESSION_TTL_MS,
  sessionCookieOptions,
  createSessionToken,
  verifySessionToken,
} from "../app/auth-session";

// #99: the session cookie is a signed HS256 JWT. These tests pin the security
// properties the ACs + NFRs require: HttpOnly, SameSite=Lax, tamper-proof,
// expiry-enforced, and no DB.
const SECRET = "unit-test-secret-not-a-real-key-0123456789";

describe("session cookie options (#99)", () => {
  it("is HttpOnly, SameSite=Lax and path-scoped to /", () => {
    const o = sessionCookieOptions({ secure: true, maxAgeSeconds: 3600 });
    expect(o.httpOnly).toBe(true);
    expect(o.sameSite).toBe("lax");
    expect(o.path).toBe("/");
    expect(o.secure).toBe(true);
    expect(o.maxAge).toBe(3600);
  });

  it("drops Secure for local HTTP dev", () => {
    expect(
      sessionCookieOptions({ secure: false, maxAgeSeconds: 60 }).secure,
    ).toBe(false);
  });

  it("defaults maxAge to the default TTL", () => {
    expect(sessionCookieOptions({ secure: true }).maxAge).toBe(
      DEFAULT_SESSION_TTL_MS / 1000,
    );
  });

  it("keeps a stable cookie name", () => {
    expect(SESSION_COOKIE_NAME).toBe("eve_session");
  });
});

describe("session token (#99)", () => {
  it("round-trips the email", async () => {
    const token = await createSessionToken({
      email: "cuillinguy@gmail.com",
      secret: SECRET,
    });
    const payload = await verifySessionToken(token, { secret: SECRET });
    expect(payload?.email).toBe("cuillinguy@gmail.com");
  });

  it("derives iat/exp from now + ttl", async () => {
    const now = 1_700_000_000_000;
    const token = await createSessionToken({
      email: "a@b.com",
      secret: SECRET,
      now,
      ttlMs: 60_000,
    });
    const payload = await verifySessionToken(token, { secret: SECRET, now });
    expect(payload?.iat).toBe(Math.floor(now / 1000));
    expect(payload?.exp).toBe(Math.floor(now / 1000) + 60);
  });

  it("rejects a tampered token", async () => {
    const token = await createSessionToken({
      email: "cuillinguy@gmail.com",
      secret: SECRET,
    });
    const tampered = token.slice(0, -3) + "abc";
    expect(await verifySessionToken(tampered, { secret: SECRET })).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken({
      email: "cuillinguy@gmail.com",
      secret: SECRET,
    });
    expect(
      await verifySessionToken(token, { secret: "a-different-secret" }),
    ).toBeNull();
  });

  it("rejects an expired token", async () => {
    const now = 1_700_000_000_000;
    const token = await createSessionToken({
      email: "a@b.com",
      secret: SECRET,
      now,
      ttlMs: 1000,
    });
    expect(
      await verifySessionToken(token, { secret: SECRET, now: now + 5000 }),
    ).toBeNull();
  });

  it("rejects missing / malformed tokens", async () => {
    for (const t of [null, undefined, "", "not-a-jwt", "a.b.c"]) {
      expect(await verifySessionToken(t, { secret: SECRET })).toBeNull();
    }
  });
});
