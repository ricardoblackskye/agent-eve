import { type NextRequest, NextResponse } from "next/server";
import {
  listViewableEntries,
  openSandboxView,
  readViewableFile,
  type SandboxViewResponse,
} from "../../../../../../agent/lib/dark-factory/sandbox-view";
import { resolveViewer } from "../../../viewer";
import { badRequest, forbidden, okJson, unauthorized } from "../../../responses";

/**
 * #790 R1 (#791) - the read-only sandbox view of a RUNNING local run.
 *
 * The console the operator already has open serves this. Nothing is exposed: no listener, no ingress, no tunnel, and no
 * URL that could carry a credential - the auth is the console's own, and the answer is derived per request.
 *
 * The server decides whether a view exists at all, never the browser. `openSandboxView` answers `not-local` when the
 * run's sandbox is not on this machine (a deployed console has nothing to point at, so it must not hang probing for
 * it), and `no-live-sandbox` once the run's sandbox is gone - "the view has ended", rather than a stale link that
 * waits forever.
 *
 * Read-only is the shape of this handler: it lists and reads, and every response is `available: false` or a listing of
 * paths the filter allows. There is no verb here that changes the workspace.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const resolved = await resolveViewer(request);
  if (!resolved.ok) {
    return resolved.status === 401 ? unauthorized() : forbidden(resolved.error);
  }

  const { runId } = await context.params;
  const search = new URL(request.url).searchParams;
  const file = search.get("file");
  const directory = search.get("path");

  const view = await openSandboxView({ runId });
  if (!view.ok) {
    return okJson({
      available: false,
      reason: view.reason,
      message: view.message,
    } satisfies SandboxViewResponse);
  }

  try {
    if (file) {
      const read = await readViewableFile({ handle: view.session.reader, path: file });
      if (!read.ok) {
        // A refused path is the caller's mistake, not an outage; everything else is still an answer.
        return read.reason === "refused"
          ? badRequest(read.message)
          : okJson({
              available: false,
              reason: "unreadable",
              message: read.message,
            } satisfies SandboxViewResponse);
      }
      return okJson({
        available: true,
        sandboxId: view.session.sandboxId,
        workspace: view.session.workspace,
        entries: [],
        file: { path: read.path, content: read.content, truncated: read.truncated },
      } satisfies SandboxViewResponse);
    }

    const entries = await listViewableEntries({
      handle: view.session.reader,
      path: directory ?? view.session.workspace,
    });
    return okJson({
      available: true,
      sandboxId: view.session.sandboxId,
      workspace: view.session.workspace,
      entries,
    } satisfies SandboxViewResponse);
  } catch (error) {
    return okJson({
      available: false,
      reason: "unreadable",
      message: `The sandbox did not answer while the workspace was read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    } satisfies SandboxViewResponse);
  } finally {
    // Every request opens its own client; every request releases it. The run's sandbox is untouched.
    await view.session.release();
  }
}
