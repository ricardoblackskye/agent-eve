import { type NextRequest, NextResponse } from "next/server";

import { resolveViewer } from "../viewer";
import { badRequest, forbidden, okJson, unauthorized } from "../responses";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await resolveViewer(request);
  if (!resolved.ok) {
    return resolved.status === 401 ? unauthorized() : forbidden(resolved.error);
  }

  // #465 RED placeholder: the read through the configured store lands in GREEN.
  return okJson({ scan: null });
}
