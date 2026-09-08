import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { signPayload, canSign, signingSecret } from "../evals/helpers/sign";

describe("eval webhook signing (#82)", () => {
  it("reports it cannot sign when no secret is configured", () => {
    expect(canSign({})).toBe(false);
  });

  it("reports it can sign when the secret is present", () => {
    expect(canSign({ GH_WEBHOOK_SECRET: "s" })).toBe(true);
  });

  it("treats an empty secret as absent", () => {
    expect(canSign({ GH_WEBHOOK_SECRET: "" })).toBe(false);
  });

  it("returns the secret when set", () => {
    expect(signingSecret({ GH_WEBHOOK_SECRET: "abc" })).toBe("abc");
  });

  it("produces the sha256= prefixed HMAC the handler expects", () => {
    const sig = signPayload('{"a":1}', "test-secret");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("matches what the webhook route computes", async () => {
    const crypto = await import("crypto");
    const body = '{"a":1}';
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", "test-secret").update(body).digest("hex");
    expect(signPayload(body, "test-secret")).toBe(expected);
  });

  it("produces different signatures for different bodies", () => {
    expect(signPayload('{"a":1}', "s")).not.toBe(signPayload('{"a":2}', "s"));
  });
});

describe("webhook evals sign their requests (#82)", () => {
  for (const file of ["webhook.eval.ts", "multi-repo-config.eval.ts"]) {
    it(`${file} imports the signing helper`, () => {
      const src = readFileSync(`evals/${file}`, "utf-8");
      expect(src).toMatch(/helpers\/sign/);
    });

    it(`${file} adds the signature header`, () => {
      const src = readFileSync(`evals/${file}`, "utf-8");
      expect(src).toMatch(/x-hub-signature-256/);
    });

    it(`${file} skips rather than fails when it cannot sign`, () => {
      const src = readFileSync(`evals/${file}`, "utf-8");
      expect(src).toMatch(/canSign\(\)/);
    });
  }
});
