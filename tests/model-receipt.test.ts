/**
 * #472 (part 2) — the offline assertion has to be real.
 *
 * Hermetic: nothing here touches the network. The live provider check is opt-in
 * (LIVE_CONTRACT=1) and lives in the availability contract test.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as modelConfig from "../agent/model-config";
import {
  RECEIPT_TTL_DAYS,
  buildReceipt,
  parseReceipt,
  receiptAgeDays,
  stalenessWarning,
  unverifiedModelIds,
} from "./support/openrouter-model-receipt";

const RECEIPT_PATH = resolve(
  process.cwd(),
  "tests/support/openrouter-model-receipt.json",
);

/** Every model id the repo declares, whatever it is named. */
function declaredModelIds(): string[] {
  return Object.entries(modelConfig)
    .filter(
      ([name, value]) => name.endsWith("_MODEL_ID") && typeof value === "string",
    )
    .map(([, value]) => value as string);
}

const validReceipt = {
  verifiedAt: "2026-01-01",
  source: "https://openrouter.ai/api/v1/models",
  models: ["a/b", "c/d"],
};

describe("#472 receipt parsing", () => {
  it("rejects invalid JSON", () => {
    const parsed = parseReceipt("{not json");
    expect(parsed.kind).toBe("malformed");
  });

  it("rejects a models field that is not an array", () => {
    const parsed = parseReceipt(
      JSON.stringify({ ...validReceipt, models: "a/b" }),
    );
    expect(parsed.kind).toBe("malformed");
  });

  it("rejects a models array holding a non-string", () => {
    const parsed = parseReceipt(
      JSON.stringify({ ...validReceipt, models: ["a/b", 7] }),
    );
    expect(parsed.kind).toBe("malformed");
  });

  it("rejects a verifiedAt that is not an ISO date", () => {
    const parsed = parseReceipt(
      JSON.stringify({ ...validReceipt, verifiedAt: "last tuesday" }),
    );
    expect(parsed.kind).toBe("malformed");
  });

  it("accepts a well-formed receipt", () => {
    const parsed = parseReceipt(JSON.stringify(validReceipt));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") expect(parsed.receipt.models).toEqual(["a/b", "c/d"]);
  });
});

describe("#472 receipt coverage", () => {
  it("names each declared id that has no entry", () => {
    expect(unverifiedModelIds(validReceipt, ["a/b", "zz/zz"])).toEqual(["zz/zz"]);
  });

  it("names none when every declared id has an entry", () => {
    expect(unverifiedModelIds(validReceipt, ["a/b"])).toEqual([]);
  });

  // THE assertion this whole file exists for: hermetic, and real.
  it("the committed receipt covers every declared model id", () => {
    expect(
      existsSync(RECEIPT_PATH),
      "no receipt at tests/support/openrouter-model-receipt.json — run: npm run models:verify",
    ).toBe(true);

    const parsed = parseReceipt(readFileSync(RECEIPT_PATH, "utf8"));
    expect(parsed.kind, "the committed receipt is malformed").toBe("ok");
    if (parsed.kind !== "ok") return;

    expect(
      unverifiedModelIds(parsed.receipt, declaredModelIds()),
      "unverified model id(s) — run: npm run models:verify",
    ).toEqual([]);
  });
});

describe("#472 receipt staleness", () => {
  it("measures age in whole days", () => {
    expect(receiptAgeDays(validReceipt, new Date("2026-01-31T00:00:00Z"))).toBe(30);
  });

  it("warns once the receipt is older than the TTL", () => {
    const warning = stalenessWarning(validReceipt, new Date("2026-06-01T00:00:00Z"));
    expect(warning).toMatch(/older than/i);
  });

  it("stays quiet while the receipt is fresh", () => {
    expect(stalenessWarning(validReceipt, new Date("2026-01-05T00:00:00Z"))).toBeNull();
  });

  it("warns rather than throwing when stale", () => {
    const warning = stalenessWarning(validReceipt, new Date("2027-01-01T00:00:00Z"));
    expect(typeof warning).toBe("string");
  });

  it("defaults the TTL to 90 days", () => {
    expect(RECEIPT_TTL_DAYS).toBe(90);
  });
});

describe("#472 receipt construction", () => {
  it("records the ids, the source and the verification date", () => {
    const receipt = buildReceipt(
      ["a/b"],
      "https://example.test/models",
      new Date("2026-03-04T12:00:00Z"),
    );
    expect(receipt.verifiedAt).toBe("2026-03-04");
    expect(receipt.models).toEqual(["a/b"]);
    expect(receipt.source).toBe("https://example.test/models");
  });
});
