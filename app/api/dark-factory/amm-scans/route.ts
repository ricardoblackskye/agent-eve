import { type NextRequest, NextResponse } from "next/server";

import { ammProviderFromEnv } from "../../../../agent/lib/dark-factory/amm-scan-provider";
import { resolveViewer } from "../viewer";
import {
  badRequest,
  forbidden,
  okJson,
  unauthorized,
} from "../responses";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await resolveViewer(request);
  if (!resolved.ok) {
    return resolved.status === 401 ? unauthorized() : forbidden(resolved.error);
  }

  const repo = new URL(request.url).searchParams.get("repo");
  if (!repo) {
    return badRequest("repo query parameter is required");
  }

  // #465 - read through the configured store. With no store this throws, which is the deliberate, fail-closed
  // decision: a detail page that cannot measure must not render a fabricated figure.
  try {
    const provider = ammProviderFromEnv();
    try {
      const scan = await provider.scan(repo);
      return okJson({ scan: scan ?? null });
    } finally {
      provider.close?.();
    }
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : "the AMM scan store is not configured",
    );
  }
}
