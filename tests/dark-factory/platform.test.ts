import { describe, expect, it } from "vitest";
import {
  createPlatformAdapter,
  PlatformConfigurationError,
} from "../../agent/lib/dark-factory/platform";

describe("createPlatformAdapter", () => {
  it("maps the selected Vercel deployment and URL", () => {
    const adapter = createPlatformAdapter({
      DF_PLATFORM_PROVIDER: "vercel",
      VERCEL_ENV: "production",
      VERCEL_URL: "agent-eve.vercel.app",
    });

    expect(adapter.id).toBe("vercel");
    expect(adapter.context).toEqual({
      providerId: "vercel",
      stage: "production",
      apiOrigin: "https://agent-eve.vercel.app",
    });
  });

  it("prefers an explicit API origin to the Vercel-provided URL", () => {
    const adapter = createPlatformAdapter({
      DF_PLATFORM_PROVIDER: "vercel",
      DF_API_BASE_URL: "https://agent.example.test/eve/v1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "preview-agent.vercel.app",
    });

    expect(adapter.context.apiOrigin).toBe("https://agent.example.test");
  });

  it("uses explicit generic deployment settings without reading Vercel markers", () => {
    const adapter = createPlatformAdapter({
      DF_PLATFORM_PROVIDER: "generic",
      DF_DEPLOYMENT_ENV: "preview",
      VERCEL_ENV: "production",
      VERCEL_URL: "must-not-be-used.vercel.app",
    });

    expect(adapter.id).toBe("generic");
    expect(adapter.context).toEqual({
      providerId: "generic",
      stage: "preview",
      apiOrigin: null,
    });
  });

  it("defaults to a local generic context outside production when unset", () => {
    const adapter = createPlatformAdapter({ NODE_ENV: "test" });

    expect(adapter.context).toEqual({
      providerId: "generic",
      stage: "development",
      apiOrigin: null,
    });
  });

  it("refuses to guess a provider in production", () => {
    expect(() =>
      createPlatformAdapter({ NODE_ENV: "production", VERCEL_ENV: "production" }),
    ).toThrow(PlatformConfigurationError);
    expect(() =>
      createPlatformAdapter({ NODE_ENV: "production", VERCEL_ENV: "production" }),
    ).toThrow(/DF_PLATFORM_PROVIDER/i);
  });

  it("rejects an unknown provider instead of silently selecting another one", () => {
    expect(() =>
      createPlatformAdapter({ DF_PLATFORM_PROVIDER: "cloud-unknown" }),
    ).toThrow(PlatformConfigurationError);
    expect(() =>
      createPlatformAdapter({ DF_PLATFORM_PROVIDER: "cloud-unknown" }),
    ).toThrow(/cloud-unknown/);
  });

  it("rejects an unknown deployment stage", () => {
    expect(() =>
      createPlatformAdapter({
        DF_PLATFORM_PROVIDER: "generic",
        DF_DEPLOYMENT_ENV: "staging-like",
      }),
    ).toThrow(/DF_DEPLOYMENT_ENV/);
  });

  it("rejects an invalid configured API origin", () => {
    expect(() =>
      createPlatformAdapter({
        DF_PLATFORM_PROVIDER: "generic",
        DF_API_BASE_URL: "javascript:alert(1)",
      }),
    ).toThrow(PlatformConfigurationError);
    expect(() =>
      createPlatformAdapter({
        DF_PLATFORM_PROVIDER: "generic",
        DF_API_BASE_URL: "javascript:alert(1)",
      }),
    ).toThrow(/DF_API_BASE_URL/);
  });
});
