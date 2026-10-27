/**
 * Dark Factory — persisted plans and their cost estimates (#486, epic #453).
 *
 * Two records, deliberately separate:
 *
 * - a PLAN is written once per plan revision. A run can legitimately produce several, because
 *   `amendPlan` re-plans from human revision feedback (#378), so revision is a real dimension and
 *   not just a version number.
 * - an ESTIMATE is written once, when that plan is priced. It carries the band in typed columns so
 *   the calibration rollup is a plain GROUP BY, plus one JSON tail for the open-ended feature
 *   vector the estimator is expected to grow.
 *
 * Boundaries:
 *
 * - **No prose.** The plan is a structured `ExecutionPlan`; the human-readable text stays in the
 *   GitHub comment that `commentRef` points at. Issue text and prompts are never persisted, the
 *   same rule `RunEvent` enforces.
 * - **Write-once.** There is no upsert. A row that exists was produced by one decision, and no
 *   later lifecycle write can null it — the failure mode a shared summary column would have had.
 * - **Strict here, lenient in the stores.** These validators throw. The providers catch, so a
 *   corrupt persisted row degrades to "absent" rather than making the ledger unreadable.
 */

import type { ExecutionPlan } from "./plan-validator";
import type { CostClass, CostConfidence, PlanCostEstimate } from "./plan-cost-estimate";
import { PLAN_ESTIMATOR_VERSION } from "./plan-cost-estimate";

/** Where a plan revision came from: the first plan, or a re-plan after revision feedback. */
export type PlanSource = "architect" | "amendment";

/** A reference to the GitHub comment that holds the plan text. Never the text itself. */
export interface PlanCommentRef {
  provider: "github";
  id: number;
  url: string;
}

export interface PersistedPlan {
  planId: number;
  runId: string;
  tenantId?: string;
  planRevision: number;
  storyId: number;
  source: PlanSource;
  plan: ExecutionPlan;
  commentRef?: PlanCommentRef;
  createdAt: string;
}

/** A plan as a caller supplies it: no identity yet. */
export type PlanRecordInput = Omit<PersistedPlan, "planId">;

export interface PersistedPlanEstimate {
  estimateId: number;
  planId: number;
  runId: string;
  tenantId?: string;
  /** Cost-budget period key, `YYYY-MM`. */
  period: string;
  estimatorVersion: string;
  model: string;
  lowUsd: number;
  expectedUsd: number;
  highUsd: number;
  costClass: CostClass;
  confidence: CostConfidence;
  revisionFactor: number;
  historySamples: number;
  targetFileCount: number;
  taskCount: number;
  inputTokens: number;
  outputTokens: number;
  priceSource: string;
  /** NULL is whole-run; set once per-stage attribution lands (#492). */
  stage?: string;
  features: Record<string, number | string>;
  createdAt: string;
}

/** An estimate as a caller supplies it: no identity yet, version defaulted. */
export type PlanEstimateRecordInput = Omit<
  PersistedPlanEstimate,
  "estimateId" | "estimatorVersion"
> & { estimatorVersion?: string };

/** One row of the accuracy rollup: what was forecast, what it cost, and which way it was wrong. */
export interface PlanEstimateAccuracyRow {
  period: string;
  costClass: CostClass;
  confidence: CostConfidence;
  estimatorVersion: string;
  expectedUsd: number;
  actualUsd: number;
  signedErrorUsd: number;
}

/** The seam a store implements to persist plans and estimates. */
export interface PlanLedger {
  recordPlan(input: PlanRecordInput): Promise<PersistedPlan>;
  listPlans(runId: string): Promise<PersistedPlan[]>;
  recordPlanEstimate(input: PlanEstimateRecordInput): Promise<PersistedPlanEstimate>;
  listPlanEstimates(runId: string): Promise<PersistedPlanEstimate[]>;
  listEstimateAccuracy(period?: string): Promise<PlanEstimateAccuracyRow[]>;
}

export class InvalidPlanRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPlanRecordError";
  }
}

const PLAN_SOURCES: readonly PlanSource[] = ["architect", "amendment"];
const COST_CLASSES: readonly CostClass[] = ["XS", "S", "M", "L", "XL"];
const CONFIDENCES: readonly CostConfidence[] = ["low", "medium", "high"];

function bad(field: string, value: unknown, expected: string): never {
  throw new InvalidPlanRecordError(
    `Plan record requires "${field}" ${expected} (received ${JSON.stringify(value)}).`,
  );
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return bad(field, value, "to be a non-empty string");
  }
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return text(value, field);
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return bad(field, value, "to be a non-negative integer");
  }
  return value;
}

function amount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return bad(field, value, "to be a non-negative finite number");
  }
  return value;
}

function stamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return bad(field, value, "to be an ISO timestamp");
  }
  return value;
}

function oneOf<T extends string>(value: unknown, field: string, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    return bad(field, value, `to be one of ${choices.join(", ")}`);
  }
  return value as T;
}

function features(value: unknown): Record<string, number | string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return bad("features", value, "to be an object of numbers or strings");
  }
  const out: Record<string, number | string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      out[key] = raw;
      continue;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
      continue;
    }
    // A nested value would be a prompt, a file body or an issue excerpt. Refuse it.
    return bad(`features.${key}`, raw, "to be a string or finite number");
  }
  return out;
}

function commentRef(value: unknown): PlanCommentRef | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return bad("commentRef", value, "to be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.provider !== "github") return bad("commentRef.provider", input.provider, "to be github");
  if (typeof input.id !== "number" || !Number.isInteger(input.id) || input.id <= 0) {
    return bad("commentRef.id", input.id, "to be a positive integer");
  }
  return { provider: "github", id: input.id, url: text(input.url, "commentRef.url") };
}

/** Validate and copy one plan record. Unknown fields are discarded. */
export function toPlanRecord(input: Partial<PlanRecordInput>): PlanRecordInput {
  const plan = input.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    bad("plan", plan, "to be a structured ExecutionPlan");
  }
  const structured = plan as ExecutionPlan;
  if (typeof structured.storyId !== "number" || !Array.isArray(structured.targetFiles)) {
    bad("plan", plan, "to be a structured ExecutionPlan with a storyId and targetFiles");
  }
  const tenantId = optionalText(input.tenantId, "tenantId");
  const comment = commentRef(input.commentRef);
  return {
    runId: text(input.runId, "runId"),
    storyId: count(structured.storyId, "plan.storyId"),
    planRevision: count(input.planRevision, "planRevision"),
    source: oneOf(input.source, "source", PLAN_SOURCES),
    plan: structured,
    createdAt: stamp(input.createdAt, "createdAt"),
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(comment !== undefined ? { commentRef: comment } : {}),
  };
}

/**
 * Validate and copy one estimate. The band must be ORDERED: an inverted band is not a band, and
 * storing one would corrupt every aggregate computed from it.
 */
export function toPlanEstimateRecord(
  input: Partial<PlanEstimateRecordInput>,
): Required<Pick<PlanEstimateRecordInput, "estimatorVersion">> & PlanEstimateRecordInput {
  const lowUsd = amount(input.lowUsd, "lowUsd");
  const expectedUsd = amount(input.expectedUsd, "expectedUsd");
  const highUsd = amount(input.highUsd, "highUsd");
  if (lowUsd > expectedUsd || expectedUsd > highUsd) {
    bad("band", input, "to be ordered (low <= expected <= high)");
  }
  const period = text(input.period, "period");
  if (!/^\d{4}-\d{2}$/.test(period)) bad("period", period, "to be YYYY-MM");
  const tenantId = optionalText(input.tenantId, "tenantId");
  const stage = optionalText(input.stage, "stage");
  return {
    planId: count(input.planId, "planId"),
    runId: text(input.runId, "runId"),
    period,
    estimatorVersion: input.estimatorVersion ?? PLAN_ESTIMATOR_VERSION,
    model: text(input.model, "model"),
    lowUsd,
    expectedUsd,
    highUsd,
    costClass: oneOf(input.costClass, "costClass", COST_CLASSES),
    confidence: oneOf(input.confidence, "confidence", CONFIDENCES),
    revisionFactor: amount(input.revisionFactor, "revisionFactor"),
    historySamples: count(input.historySamples, "historySamples"),
    targetFileCount: count(input.targetFileCount, "targetFileCount"),
    taskCount: count(input.taskCount, "taskCount"),
    inputTokens: count(input.inputTokens, "inputTokens"),
    outputTokens: count(input.outputTokens, "outputTokens"),
    priceSource: text(input.priceSource, "priceSource"),
    features: features(input.features),
    createdAt: stamp(input.createdAt, "createdAt"),
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(stage !== undefined ? { stage } : {}),
  };
}

/** Convenience: turn an estimator result into a record input, minus identity and period. */
export function estimateToRecord(
  estimate: PlanCostEstimate,
): Pick<
  PlanEstimateRecordInput,
  | "lowUsd"
  | "expectedUsd"
  | "highUsd"
  | "costClass"
  | "confidence"
  | "features"
> {
  return {
    lowUsd: estimate.lowUsd,
    expectedUsd: estimate.expectedUsd,
    highUsd: estimate.highUsd,
    costClass: estimate.costClass,
    confidence: estimate.confidence,
    features: estimate.features,
  };
}
