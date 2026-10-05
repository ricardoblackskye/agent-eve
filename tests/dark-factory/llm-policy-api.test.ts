import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
} from "../../app/auth-session";
// These routes resolve role and tenant per request (#215). The guard is mocked
// so the test keeps its real session check but needs no membership store.
vi.mock("../../app/api/dark-factory/guard", async () => {
  const auth = await import("../../app/api/dark-factory/viewer-auth");
  const { unauthorized } = await import("../../app/api/dark-factory/responses");
  const viewer = { email: "operator@example.test", role: "operator" as const };
  const resolve = async (request: Request) => {
    const session = await auth.getViewerSession(request);
    return session ? { ok: true, viewer } : { ok: false, response: unauthorized() };
  };
  return { guardViewer: resolve, guardOperator: resolve };
});

import * as route from "../../app/api/dark-factory/llm-policy/route";

const secret = "test-llm-policy-session";
let cookie = "";
const KEYS = ["DF_LLM_THINKING_LEVEL", "DF_LLM_MAX_STEPS", "DF_LLM_MODEL"];
let saved: Record<string, string | undefined> = {};

const DEFAULT_PATH = "https://eve.local/api/dark-factory/llm-policy";

beforeEach(async () => {
  process.env.AUTH_SESSION_SECRET = secret;
  cookie = `${SESSION_COOKIE_NAME}=${await createSessionToken({
    email: "operator@example.test",
    secret,
  })}`;
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  delete process.env.AUTH_SESSION_SECRET;
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function req(path = DEFAULT_PATH, authenticated = true): Request {
  return new Request(path, {
    method: "GET",
    headers: authenticated ? { cookie } : {},
  });
}

describe("Dark Factory LLM policy API", () => {
  it("requires a signed viewer session", async () => {
    const response = await route.GET(req(DEFAULT_PATH, false) as never);
    expect(response.status).toBe(401);
  });

  it("reports the unconfigured state for an authenticated operator", async () => {
    const response = await route.GET(req() as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      report: { configured: boolean; surfaces: unknown[] };
    };
    expect(body.report.configured).toBe(false);
    expect(body.report.surfaces).toHaveLength(3);
  });

  it("reports the effective policy once configured", async () => {
    process.env.DF_LLM_THINKING_LEVEL = "high";
    process.env.DF_LLM_MAX_STEPS = "6";

    const response = await route.GET(req() as never);
    const body = (await response.json()) as {
      report: { configured: boolean; thinkingLevel: string; maxSteps: number };
    };

    expect(body.report.configured).toBe(true);
    expect(body.report.thinkingLevel).toBe("high");
    expect(body.report.maxSteps).toBe(6);
  });

  it("returns 400 for a malformed policy rather than a silent default", async () => {
    process.env.DF_LLM_THINKING_LEVEL = "highish";

    const response = await route.GET(req() as never);
    expect(response.status).toBe(400);
  });

  it("never exposes a secret", async () => {
    process.env.DF_LLM_THINKING_LEVEL = "high";
    process.env.OPENROUTER_API_KEY = "sk-must-not-appear";

    const response = await route.GET(req() as never);
    const text = JSON.stringify(await response.json());

    expect(text).not.toMatch(/sk-must-not-appear/);
    expect(text).not.toMatch(/API_KEY/);
    delete process.env.OPENROUTER_API_KEY;
  });
});
