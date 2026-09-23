import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  GOOGLE_AUTH_ENDPOINT,
  createPkcePair,
  createState,
  validateState,
  buildGoogleAuthUrl,
} from "../app/auth-oauth";

// #99 / security: PKCE (S256) + an unguessable, validated `state` are what stop
// a CSRF'd or replayed callback from minting a session.

describe("PKCE (#99)", () => {
  it("challenge is S256(verifier)", async () => {
    const { verifier, challenge } = await createPkcePair();
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("verifier is high-entropy across calls", async () => {
    const a = await createPkcePair();
    const b = await createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it("verifier is base64url-safe and >=43 chars (32 random bytes)", async () => {
    const { verifier } = await createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });
});

describe("OAuth state (#99)", () => {
  it("is random per call", () => {
    expect(createState()).not.toBe(createState());
  });

  it("accepts a matching, non-empty state", () => {
    expect(validateState("abc123", "abc123")).toBe(true);
  });

  it("rejects mismatch or missing values", () => {
    expect(validateState("abc123", "abc124")).toBe(false);
    expect(validateState("", "")).toBe(false);
    expect(validateState(null, "abc")).toBe(false);
    expect(validateState("abc", null)).toBe(false);
    expect(validateState(undefined, undefined)).toBe(false);
  });
});

describe("authorize URL (#99)", () => {
  it("carries every required OAuth parameter", () => {
    const raw = buildGoogleAuthUrl({
      clientId: "client-123",
      redirectUri: "https://example.com/api/auth/google/callback",
      state: "state-xyz",
      codeChallenge: "challenge-xyz",
    });
    const url = new URL(raw);
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_ENDPOINT);
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.com/api/auth/google/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("email");
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
