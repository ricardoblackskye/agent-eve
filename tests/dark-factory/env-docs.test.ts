/**
 * Doc-consistency guard for the Dark Factory R1 config surface
 * (issues #134 / #138 / #140), mirroring `tests/env-example.test.ts`.
 *
 * Every DF_* knob the R1 seams read must be documented in `.env.example`, so
 * the operator-facing setup surface cannot silently drift from the code.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const raw = readFileSync(resolve(process.cwd(), ".env.example"), "utf-8");

const DARK_FACTORY_VARS = [
  "DF_STATE_DRIVER",
  "DF_STATE_DB_PATH",
  "DF_DISPATCH_MAX_RETRIES",
  "DF_DISPATCH_BASE_DELAY_MS",
  "DF_METRICS_DRIVER",
];

describe(".env.example — Dark Factory R1 (#134/#138/#140)", () => {
  for (const name of DARK_FACTORY_VARS) {
    it(`documents ${name}`, () => {
      expect(raw).toMatch(new RegExp(`^${name}=`, "m"));
    });
  }
});