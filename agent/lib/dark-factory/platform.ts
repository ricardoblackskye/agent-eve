/**
 * Platform-specific runtime facts consumed by Dark Factory.
 *
 * Provider-specific environment variables are read only in these adapters. The
 * orchestration consumes the normalized context and never needs to know how a
 * host names its deployment stage or URL.
 */
export type PlatformProviderId = "vercel" | "generic";
export type DeploymentStage = "development" | "preview" | "production";

export interface PlatformContext {
  providerId: PlatformProviderId;
  stage: DeploymentStage;
  apiOrigin: string | null;
}

export interface PlatformAdapter {
  id: PlatformProviderId;
  context: PlatformContext;
}

export class PlatformConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformConfigurationError";
  }
}

function configuredOrigin(
  raw: string | undefined,
  variable: string,
  addHttps = false,
): string | null {
  const value = raw?.trim();
  if (!value) return null;

  const candidate =
    addHttps && !/^https?:\/\//i.test(value) ? `https://${value}` : value;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new PlatformConfigurationError(
      `${variable} must be a valid HTTP or HTTPS URL.`,
    );
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new PlatformConfigurationError(
      `${variable} must be a valid HTTP or HTTPS URL without embedded credentials.`,
    );
  }
  return parsed.origin;
}

function stageFromValue(
  raw: string | undefined,
  variable: string,
  fallback: DeploymentStage,
): DeploymentStage {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "development" || value === "preview" || value === "production") {
    return value;
  }
  throw new PlatformConfigurationError(
    `${variable} must be development, preview, or production (received '${value}').`,
  );
}

function assertNotDowngradedProduction(
  stage: DeploymentStage,
  env: Record<string, string | undefined>,
  variable: string,
): void {
  if (env.NODE_ENV?.trim().toLowerCase() === "production" && stage === "development") {
    throw new PlatformConfigurationError(
      `${variable} cannot classify a production build as development.`,
    );
  }
}

class VercelPlatformAdapter implements PlatformAdapter {
  readonly id = "vercel" as const;
  readonly context: PlatformContext;

  constructor(env: Record<string, string | undefined>) {
    const fallback =
      env.NODE_ENV?.trim().toLowerCase() === "production"
        ? "production"
        : "development";
    const stage = stageFromValue(env.VERCEL_ENV, "VERCEL_ENV", fallback);
    assertNotDowngradedProduction(stage, env, "VERCEL_ENV");
    const apiOrigin =
      configuredOrigin(env.DF_API_BASE_URL, "DF_API_BASE_URL") ??
      configuredOrigin(env.VERCEL_URL, "VERCEL_URL", true);
    this.context = { providerId: this.id, stage, apiOrigin };
  }
}

class GenericPlatformAdapter implements PlatformAdapter {
  readonly id = "generic" as const;
  readonly context: PlatformContext;

  constructor(env: Record<string, string | undefined>) {
    const fallback =
      env.NODE_ENV?.trim().toLowerCase() === "production"
        ? "production"
        : "development";
    const stage = stageFromValue(
      env.DF_DEPLOYMENT_ENV,
      "DF_DEPLOYMENT_ENV",
      fallback,
    );
    assertNotDowngradedProduction(stage, env, "DF_DEPLOYMENT_ENV");
    const apiOrigin = configuredOrigin(env.DF_API_BASE_URL, "DF_API_BASE_URL");
    this.context = { providerId: this.id, stage, apiOrigin };
  }
}

/**
 * Select the platform adapter.
 *
 * An unset selector is convenient for local development/test only. Production
 * must explicitly select a provider; otherwise the process refuses to guess.
 */
export function createPlatformAdapter(
  env: Record<string, string | undefined> = process.env,
): PlatformAdapter {
  const selected = (env.DF_PLATFORM_PROVIDER ?? "").trim().toLowerCase();
  if (!selected) {
    if (env.NODE_ENV?.trim().toLowerCase() === "production") {
      throw new PlatformConfigurationError(
        "DF_PLATFORM_PROVIDER is not configured for production.",
      );
    }
    return new GenericPlatformAdapter(env);
  }
  if (selected === "vercel") return new VercelPlatformAdapter(env);
  if (selected === "generic") return new GenericPlatformAdapter(env);
  throw new PlatformConfigurationError(
    `DF_PLATFORM_PROVIDER '${selected}' is not supported (choose 'vercel' or 'generic').`,
  );
}
