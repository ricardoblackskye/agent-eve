/**
 * GENERATED FILE - do not edit by hand.
 *
 * The observed-dearest price record consumed by `model-price-floor.ts`. Two reasons it is a TS
 * module rather than a JSON file:
 *
 *   1. `agent/` only accepts supported authored modules - the Eve build rejects a bare `.json`
 *      inside `agent/lib/` ("Expected ... to be a supported authored module within lib/").
 *   2. Being generated wholesale means the refresh script owns every line of it, so there is no
 *      hand-written region to parse and no chance of the writer and the reader disagreeing.
 *
 * Refresh with:  npm run prices:check -- --write
 *
 * It records what was SEEN, dated. It is not a mirror of the provider catalog, and it is not a
 * substitute for re-verifying: see ADR 0071.
 */

import type { PriceFloorRecord } from "./model-price-floor";
export const priceFloorRecord: PriceFloorRecord = {
  verifiedAt: "2026-10-29",
  source: "https://openrouter.ai/api/v1/models/<id>/endpoints",
  observedDearest: {
    "deepseek/deepseek-v4-pro": {
      inputUsdPer1k: 0.00191,
      outputUsdPer1k: 0.0038299999999999996,
      providers: 15,
      distribution: { input: { median: 0.0013, p90: 0.00174, secondDearest: 0.00174, providers: 15 }, output: { median: 0.0028320000000000003, p90: 0.00348, secondDearest: 0.00348, providers: 15 } },
    },
    "deepseek/deepseek-v4.1-flash": {
      inputUsdPer1k: 0.0006,
      outputUsdPer1k: 0.0024,
      providers: 41,
      distribution: { input: { median: 0.00019999999999999998, p90: 0.0003, secondDearest: 0.00045, providers: 41 }, output: { median: 0.00084, p90: 0.0012, secondDearest: 0.0018, providers: 41 } },
    },
  },
};
