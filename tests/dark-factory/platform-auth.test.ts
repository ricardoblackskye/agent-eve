import { describe, expect, it, vi } from "vitest";
import { selectPlatformAuth } from "../../agent/lib/dark-factory/platform-auth";

describe("selectPlatformAuth", () => {
  it("puts Vercel OIDC before the common auth providers only for Vercel", () => {
    const vercel = { id: "vercel-oidc" };
    const local = { id: "local-dev" };
    const bearer = { id: "bearer" };
    const createVercelAuth = vi.fn(() => vercel);

    const selected = selectPlatformAuth("vercel", createVercelAuth, [local, bearer]);

    expect(selected).toEqual([vercel, local, bearer]);
    expect(createVercelAuth).toHaveBeenCalledOnce();
  });

  it("does not construct or include Vercel OIDC for the generic platform", () => {
    const local = { id: "local-dev" };
    const bearer = { id: "bearer" };
    const createVercelAuth = vi.fn(() => ({ id: "vercel-oidc" }));

    const selected = selectPlatformAuth("generic", createVercelAuth, [local, bearer]);

    expect(selected).toEqual([local, bearer]);
    expect(createVercelAuth).not.toHaveBeenCalled();
  });
});
