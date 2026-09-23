import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "../../../auth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign out (#99): drop the session cookie and return to the gate. */
function signOut(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(
    new URL("/", request.nextUrl.origin),
    303,
  );
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return signOut(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return signOut(request);
}
