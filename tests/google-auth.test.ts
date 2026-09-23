import { describe, it, expect } from "vitest";
import {
  ALLOWED_GOOGLE_USERS,
  verifyGoogleChatAccess,
  type GoogleUserProfile,
} from "../app/google-auth";

describe("Google Auth Verification", () => {
  it("grants access for cuillinguy@gmail.com with verifiedEmail: true", () => {
    const profile: GoogleUserProfile = {
      email: "cuillinguy@gmail.com",
      verifiedEmail: true,
    };
    const result = verifyGoogleChatAccess(profile);
    expect(result.allowed).toBe(true);
    expect(result.email).toBe("cuillinguy@gmail.com");
  });

  it("handles case-insensitivity", () => {
    const profile: GoogleUserProfile = {
      email: "CUILLINGUY@GMAIL.COM",
      verifiedEmail: true,
    };
    const result = verifyGoogleChatAccess(profile);
    expect(result.allowed).toBe(true);
    expect(result.email).toBe("cuillinguy@gmail.com");
  });

  it("handles leading/trailing whitespace", () => {
    const profile: GoogleUserProfile = {
      email: "  cuillinguy@gmail.com  ",
      verifiedEmail: true,
    };
    const result = verifyGoogleChatAccess(profile);
    expect(result.allowed).toBe(true);
    expect(result.email).toBe("cuillinguy@gmail.com");
  });

  it("rejects unauthorized email address", () => {
    const profile: GoogleUserProfile = {
      email: "someone.else@gmail.com",
      verifiedEmail: true,
    };
    const result = verifyGoogleChatAccess(profile);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Unauthorized email");
  });

  it("rejects unverified email", () => {
    const profile: GoogleUserProfile = {
      email: "cuillinguy@gmail.com",
      verifiedEmail: false,
    };
    const result = verifyGoogleChatAccess(profile);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Email not verified");
  });

  it("rejects missing email", () => {
    const profile: GoogleUserProfile = {
      verifiedEmail: true,
    };
    const result = verifyGoogleChatAccess(profile);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Missing email");
  });

  it("rejects empty email", () => {
    const profile: GoogleUserProfile = {
      email: "",
      verifiedEmail: true,
    };
    const result = verifyGoogleChatAccess(profile);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Missing email");
  });

  it("rejects null profile", () => {
    const result = verifyGoogleChatAccess(null);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Missing profile");
  });

  it("accepts an injected allow-list (ALLOWED_GOOGLE_EMAIL override)", () => {
    const profile: GoogleUserProfile = {
      email: "me@example.com",
      verifiedEmail: true,
    };
    expect(verifyGoogleChatAccess(profile).allowed).toBe(false);
    expect(verifyGoogleChatAccess(profile, ["me@example.com"]).allowed).toBe(
      true,
    );
  });

  it("rejects undefined profile", () => {
    const result = verifyGoogleChatAccess(undefined);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Missing profile");
  });
});
