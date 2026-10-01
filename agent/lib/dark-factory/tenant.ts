/**
 * Dark Factory — canonical customer tenant model (#213, epic #212 R1).
 *
 * A tenant is a customer whose Dark Factory activity and measured LLM spend we
 * attribute. The id is OPAQUE and STABLE: it is never the slug and never a
 * repository name, so renaming either cannot break attribution.
 *
 * This module is the intake seam for untrusted identifiers. Repository slugs
 * arrive from webhooks, so they are validated and normalised HERE, before they
 * reach any canonical payload, log line, or dry-run provider.
 */

import { randomUUID } from "node:crypto";

export type TenantStatus = "active" | "inactive";

export interface Tenant {
  /** Opaque, stable, immutable. A UUID. Never the slug. */
  id: string;
  /** Human-facing, unique, mutable. Lowercase `[a-z0-9-]`. */
  slug: string;
  name: string;
  status: TenantStatus;
  /** ISO-8601 UTC. */
  createdAt: string;
}

/** A configuration or input error, distinct from a runtime failure. */
export class InvalidTenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTenantError";
  }
}

export const TENANT_SLUG_MAX_LENGTH = 64;
export const REPO_SLUG_MAX_LENGTH = 140;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const REPO_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

/** Generate a new opaque tenant id. */
export function newTenantId(): string {
  return randomUUID();
}

/** Validate an opaque tenant id, or throw `InvalidTenantError`. */
export function validateTenantId(id: string): string {
  if (typeof id !== "string") {
    throw new InvalidTenantError("tenant id must be a string");
  }
  const trimmed = id.trim().toLowerCase();
  if (!UUID_RE.test(trimmed)) {
    throw new InvalidTenantError(
      `tenant id must be a UUID (received ${JSON.stringify(id)})`,
    );
  }
  return trimmed;
}

/** Validate a tenant slug, or throw `InvalidTenantError`. */
export function validateTenantSlug(slug: string): string {
  if (typeof slug !== "string") {
    throw new InvalidTenantError("tenant slug must be a string");
  }
  const trimmed = slug.trim();
  if (trimmed.length === 0) {
    throw new InvalidTenantError("tenant slug must not be empty");
  }
  if (trimmed.length > TENANT_SLUG_MAX_LENGTH) {
    throw new InvalidTenantError(
      `tenant slug must be at most ${TENANT_SLUG_MAX_LENGTH} characters`,
    );
  }
  if (!SLUG_RE.test(trimmed)) {
    throw new InvalidTenantError(
      `tenant slug must be lowercase alphanumeric with hyphens (received ${JSON.stringify(slug)})`,
    );
  }
  return trimmed;
}

/**
 * Normalise a GitHub `owner/repo` into a canonical lowercase slug, or throw
 * `InvalidTenantError`. Rejects rather than strips: a slug that is not a
 * plausible repository name is a bug or an attack, not something to repair.
 */
export function normalizeRepoSlug(input: string): string {
  if (typeof input !== "string") {
    throw new InvalidTenantError("repository slug must be a string");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new InvalidTenantError("repository slug must not be empty");
  }
  if (trimmed.length > REPO_SLUG_MAX_LENGTH) {
    throw new InvalidTenantError(
      `repository slug must be at most ${REPO_SLUG_MAX_LENGTH} characters`,
    );
  }

  const parts = trimmed.split("/");
  if (parts.length !== 2) {
    throw new InvalidTenantError(
      `repository slug must be owner/repo (received ${JSON.stringify(input)})`,
    );
  }

  const [owner, repo] = parts;
  for (const segment of [owner, repo]) {
    if (segment.length === 0) {
      throw new InvalidTenantError(
        `repository slug must have a non-empty owner and repo (received ${JSON.stringify(input)})`,
      );
    }
    if (segment === "." || segment === "..") {
      throw new InvalidTenantError(
        `repository slug must not contain a path segment (received ${JSON.stringify(input)})`,
      );
    }
    if (!REPO_SEGMENT_RE.test(segment)) {
      throw new InvalidTenantError(
        `repository slug may only contain letters, digits, dot, dash and underscore (received ${JSON.stringify(input)})`,
      );
    }
  }

  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * True when the tenant may accept new customer work.
 *
 * Fail-closed: anything that is not explicitly `active` is treated as unable to
 * accept work.
 */
export function isTenantActive(tenant: Pick<Tenant, "status">): boolean {
  return tenant.status === "active";
}