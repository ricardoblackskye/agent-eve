"use client";

import type { LlmPolicyReport } from "../../../agent/lib/dark-factory/llm-policy-query";
import { useRunQuery } from "./use-run-query";

export interface LlmPolicyResponse {
  report: LlmPolicyReport;
}

export const LLM_POLICY_PATH = "/api/dark-factory/llm-policy";

/** Operator-only, read-only effective-policy read; polls like the other panels. */
export function useLlmPolicy() {
  return useRunQuery<LlmPolicyResponse>(LLM_POLICY_PATH);
}
