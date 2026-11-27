import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VIEW_CHARS,
  readViewableFile,
  type SandboxViewClient,
} from "../../agent/lib/dark-factory/sandbox-view";

/**
 * #790 R1 (#791) - the sandbox-view ENDPOINT (task 5).
 *
 * The console serves the view, and the server decides whether one exists: the browser never does. Four things are
 * asserted here, and the negatives are the point of three of them:
 *
 *   - a view that is not on offer answers with a REASON (200, never a hang and never a hint of a link);
 *   - the filter is applied by the route, so a denylisted file is not in the listing even though the sandbox reported
 *     it - and a refused FILE is refused BEFORE the sandbox is asked for it, because the read is the exposure;
 *   - the client the request opened is released, whatever happened while it was open;
 *   - a read that fails is an answer too, not a 500.
 *
 * `openSandboxView` is the only thing mocked: the filter and the reader are the real ones.
 */

const openHolder = vi.hoisted(() => ({ impl: null as unknown as () => Promise<unknown> }));
const viewerHolder = vi.hoisted(() => ({
  resolution: {
    ok: true,
    viewer: { email: "viewer@example.com", role: "operator" },
  } as any,
}));

vi.mock("../../agent/lib/dark-factory/sandbox-view", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../agent/lib/dark-factory/sandbox-view")>();
  return {
    ...actual,
    openSandboxView: () => openHolder.impl(),
  };
});

vi.mock("../../app/api/dark-factory/viewer", () => ({
  resolveViewer: async () => viewerHolder.resolution,
}));

import * as route from "../../app/api/dark-factory/runs/[runId]/sandbox-view/route";

afterEach(() => {
  viewerHolder.resolution = {
    ok: true,
    viewer: { email: "viewer@example.com", role: "operator" },
  };
});

function request(url = "https://eve.local/api/dark-factory/runs/run-1/sandbox-view") {
  return new Request(url) as never;
}

const context = { params: Promise.resolve({ runId: "run-1" }) };

/** A session over a workspace holding one source file and one secret, with a throwing write path. */
function session(
  entries: Array<{ path: string; type?: string }> = [
    { path: "src/App.tsx", type: "file" },
    { path: ".env.local", type: "file" },
  ],
  contents: Record<string, string> = {
    "src/App.tsx": "export default function App() { return null; }",
    ".env.local": "SECRET=canary-value",
  },
) {
  const released: number[] = [];
  const read: string[] = [];
  const client = {
    files: {
      listDirectory: async () => entries,
      readFile: async (path: string) => {
        read.push(path);
        if (!(path in contents)) throw new Error(`not found: ${path}`);
        return contents[path];
      },
      writeFiles: () => {
        throw new Error("the view must never write");
      },
    },
    commands: {
      run: () => {
        throw new Error("the view must never exec");
      },
    },
    close: async () => {
      released.push(released.length + 1);
    },
  } as unknown as SandboxViewClient;
  return {
    session: { sandboxId: "sb-1", workspace: "/workspace", reader: client, release: async () => void released.push(released.length + 1) },
    released,
    read,
  };
}

describe("#790 R1 - the sandbox-view endpoint decides, and says why", () => {
  it("refuses an unauthenticated viewer before it looks for a sandbox", async () => {
    viewerHolder.resolution = { ok: false, status: 401, error: "Not authenticated." };
    const opened = vi.fn();
    openHolder.impl = opened;

    const response = await route.GET(request(), context);

    expect(response.status).toBe(401);
    expect(opened).not.toHaveBeenCalled();
  });

  it("answers a reason when no view is on offer, rather than a link or a hang", async () => {
    openHolder.impl = async () => ({
      ok: false,
      reason: "no-live-sandbox",
      message: "No local sandbox is running for this run any more: the view has ended.",
    });

    const response = await route.GET(request(), context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.available).toBe(false);
    expect(body.reason).toBe("no-live-sandbox");
    expect(JSON.stringify(body)).toMatch(/ended/i);
  });

  it("lists the workspace, omitting a denylisted entry, and releases the client it opened", async () => {
    const { session: opened, released } = session();
    openHolder.impl = async () => ({ ok: true, session: opened });

    const response = await route.GET(request(), context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.available).toBe(true);
    expect(body.sandboxId).toBe("sb-1");
    expect(body.entries.map((entry: { path: string }) => entry.path)).toEqual(["src/App.tsx"]);
    expect(JSON.stringify(body)).not.toContain("canary-value");
    expect(released).toHaveLength(1);
  });

  it("serves one file's contents, and refuses a denylisted path BEFORE reading it", async () => {
    const { session: opened, read } = session();
    openHolder.impl = async () => ({ ok: true, session: opened });

    const served = await route.GET(
      request("https://eve.local/api/dark-factory/runs/run-1/sandbox-view?file=src%2FApp.tsx"),
      context,
    );
    const servedBody = await served.json();
    expect(servedBody.file.content).toContain("export default function App");
    expect(servedBody.file.truncated).toBe(false);

    const refused = await route.GET(
      request("https://eve.local/api/dark-factory/runs/run-1/sandbox-view?file=.env.local"),
      context,
    );
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toMatch(/not served/i);
    // The exposure is the READ, so a refused path must never reach the sandbox.
    expect(read).toEqual(["src/App.tsx"]);
  });

  it("answers a read that fails, and still releases the client", async () => {
    const released: number[] = [];
    const opened = {
      sandboxId: "sb-1",
      workspace: "/workspace",
      reader: {
        files: {
          listDirectory: async () => {
            throw new Error("execd went away");
          },
          readFile: async () => "",
        },
      },
      release: async () => void released.push(1),
    } as unknown as SandboxViewClient & { sandboxId: string; workspace: string };
    openHolder.impl = async () => ({ ok: true, session: opened });

    const response = await route.GET(request(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: false, reason: "unreadable" });
    expect(released).toHaveLength(1);
  });
});

describe("#790 R1 - reading one file through the view", () => {
  it("refuses a denylisted path without asking the sandbox for it", async () => {
    const read: string[] = [];
    const handle = {
      files: {
        listDirectory: async () => [],
        readFile: async (path: string) => {
          read.push(path);
          return "SECRET=canary-value";
        },
      },
    };

    const result = await readViewableFile({ handle, path: ".env.local" });

    expect(result.ok).toBe(false);
    expect(read).toEqual([]);
  });

  it("truncates a file past the cap, and says so", async () => {
    const big = "x".repeat(MAX_VIEW_CHARS + 500);
    const handle = {
      files: { listDirectory: async () => [], readFile: async () => big },
    };

    const result = await readViewableFile({ handle, path: "dist/bundle.js" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toHaveLength(MAX_VIEW_CHARS);
    expect(result.truncated).toBe(true);
  });

  it("reports a file it cannot read rather than throwing", async () => {
    const handle = {
      files: {
        listDirectory: async () => [],
        readFile: async () => {
          throw new Error("not found: src/gone.ts");
        },
      },
    };

    const result = await readViewableFile({ handle, path: "src/gone.ts" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unreadable");
    expect(result.message).toMatch(/gone\.ts/);
  });
});
