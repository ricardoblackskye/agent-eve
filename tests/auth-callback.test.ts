import { describe, it, expect } from "vitest";
import { decideCallback } from "../app/auth-callback";

// #99 ACs: allowed email -> the page they asked for; anything else -> the
// 'unauthorized' page.
describe("callback decision (#99)", () => {
  it("sends an allowed user to the requested page with their email", () => {
    const d = decideCallback(
      { allowed: true, email: "cuillinguy@gmail.com" },
      "/architecture",
    );
    expect(d.allowed).toBe(true);
    expect(d.redirectTo).toBe("/architecture");
    expect(d.email).toBe("cuillinguy@gmail.com");
  });

  it("sends a denied user to /unauthorized, carrying the reason", () => {
    const d = decideCallback(
      { allowed: false, reason: "Unauthorized email" },
      "/",
    );
    expect(d.allowed).toBe(false);
    expect(d.redirectTo).toBe("/unauthorized");
    expect(d.reason).toBe("Unauthorized email");
  });

  it("sanitises an unsafe next path", () => {
    expect(
      decideCallback({ allowed: true, email: "a@b.com" }, "//evil.com")
        .redirectTo,
    ).toBe("/");
  });

  it("defaults to / when no next path is given", () => {
    expect(
      decideCallback({ allowed: true, email: "a@b.com" }, "").redirectTo,
    ).toBe("/");
  });
});
