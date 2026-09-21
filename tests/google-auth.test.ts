import { describe, it, expect } from "vitest";
import {
  verifyGoogleChatAccess,
  ALLOWED_GOOGLE_USERS,
} from "../app/google-auth";

describe("Google Authentication Access Control (#97)", () => {
  it("authorizes cuillinguy@gmail.com", () => {
    const result = verifyGoogleChatAccess({
      email: "cuillinguy@gmail.com",
      verifiedEmail: true,
    });
    expect(result.authorized).toBe(true);
    expect(result.email).toBe("cuillinguy@gmail.com");
  });

  it("handles case-insensitive email matching", () => {
    const result = verifyGoogleChatAccess({
      email: "CuillinGuy@Gmail.com",
      verifiedEmail: true,
    });
    expect(result.authorized).toBe(true);
  });

  it("refuses unauthorized users", () => {
    const result = verifyGoogleChatAccess({
      email: "unauthorized@example.com",
      verifiedEmail: true,
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toContain("not authorized");
  });

  it("refuses missing or empty profile", () => {
    expect(verifyGoogleChatAccess(null).authorized).toBe(false);
    expect(verifyGoogleChatAccess({ email: "" }).authorized).toBe(false);
  });
});
