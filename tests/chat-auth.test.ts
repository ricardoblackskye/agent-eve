import { describe, it, expect, vi, afterEach } from "vitest";
import { getEveChatHeaders } from "../app/chat-auth";

describe("chat auth header (issue #42)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends Bearer token when NEXT_PUBLIC_EVE_API_KEY is set", () => {
    vi.stubEnv("NEXT_PUBLIC_EVE_API_KEY", "eve_sk_test_123");
    expect(getEveChatHeaders()).toEqual({
      authorization: "Bearer eve_sk_test_123",
    });
  });

  it("sends no header when NEXT_PUBLIC_EVE_API_KEY is unset", () => {
    vi.unstubAllEnvs();
    expect(getEveChatHeaders()).toEqual({});
  });
});
