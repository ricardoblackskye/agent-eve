import { describe, it, expect } from "vitest";
import {
  DEFAULT_ALLOWED_EMAIL,
  isProduction,
  isDevAuthEnabled,
  resolveAllowedEmails,
  buildRedirectUri,
  resolveSessionSecret,
  DEV_SESSION_SECRET,
} from "../app/auth-config";

// #99 security: dev mode must be FAIL-CLOSED — never active in production, so a
// misconfigured deploy can't hand out sessions without Google.
describe("dev auth mode (#99)", () => {
  it("is on only when AUTH_DEV_MODE is truthy and not production", () => {
    expect(
      isDevAuthEnabled({ AUTH_DEV_MODE: "1", NODE_ENV: "development" }),
    ).toBe(true);
    expect(isDevAuthEnabled({ AUTH_DEV_MODE: "true" })).toBe(true);
    expect(isDevAuthEnabled({ AUTH_DEV_MODE: "yes", NODE_ENV: "test" })).toBe(
      true,
    );
  });

  it("REFUSES in production even when explicitly set", () => {
    expect(
      isDevAuthEnabled({ AUTH_DEV_MODE: "1", NODE_ENV: "production" }),
    ).toBe(false);
    expect(
      isDevAuthEnabled({ AUTH_DEV_MODE: "true", NODE_ENV: "production" }),
    ).toBe(false);
  });

  it("is off by default and for falsy values", () => {
    expect(isDevAuthEnabled({})).toBe(false);
    expect(isDevAuthEnabled({ AUTH_DEV_MODE: "" })).toBe(false);
    expect(isDevAuthEnabled({ AUTH_DEV_MODE: "0" })).toBe(false);
    expect(isDevAuthEnabled({ AUTH_DEV_MODE: "false" })).toBe(false);
  });

  it("detects production", () => {
    expect(isProduction({ NODE_ENV: "production" })).toBe(true);
    expect(isProduction({ NODE_ENV: "development" })).toBe(false);
    expect(isProduction({})).toBe(false);
  });
});

describe("allowed email config (#99)", () => {
  it("defaults to cuillinguy@gmail.com", () => {
    expect(DEFAULT_ALLOWED_EMAIL).toBe("cuillinguy@gmail.com");
    expect(resolveAllowedEmails({})).toEqual(["cuillinguy@gmail.com"]);
  });

  it("uses ALLOWED_GOOGLE_EMAIL, normalised", () => {
    expect(
      resolveAllowedEmails({ ALLOWED_GOOGLE_EMAIL: " Me@Example.COM " }),
    ).toEqual(["me@example.com"]);
  });

  it("supports a comma-separated list", () => {
    expect(
      resolveAllowedEmails({ ALLOWED_GOOGLE_EMAIL: "a@x.com, b@y.com" }),
    ).toEqual(["a@x.com", "b@y.com"]);
  });
});

describe("redirect URI (#99)", () => {
  it("prefers GOOGLE_REDIRECT_URI", () => {
    expect(
      buildRedirectUri(
        { GOOGLE_REDIRECT_URI: "https://x/cb" },
        "https://origin",
      ),
    ).toBe("https://x/cb");
  });

  it("derives from the request origin otherwise", () => {
    expect(buildRedirectUri({}, "https://origin")).toBe(
      "https://origin/api/auth/google/callback",
    );
  });
});
describe("session secret (#99)", () => {
  it("uses AUTH_SESSION_SECRET when set", () => {
    expect(resolveSessionSecret({ AUTH_SESSION_SECRET: "a-unit-test-session-secret" })).toBe(
      "a-unit-test-session-secret",
    );
  });
  it("returns null in production without a secret (fail-closed)", () => {
    expect(resolveSessionSecret({ NODE_ENV: "production" })).toBeNull();
    expect(
      resolveSessionSecret({ NODE_ENV: "production", AUTH_DEV_MODE: "1" }),
    ).toBeNull();
  });
  it("falls back to the dev secret only in dev mode", () => {
    expect(resolveSessionSecret({ AUTH_DEV_MODE: "1" })).toBe(
      DEV_SESSION_SECRET,
    );
    expect(resolveSessionSecret({})).toBeNull();
  });
});
