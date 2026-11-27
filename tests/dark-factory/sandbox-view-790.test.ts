import { describe, expect, it } from "vitest";
import {
  isViewablePath,
  listViewableEntries,
  type WorkspaceReader,
} from "../../agent/lib/dark-factory/sandbox-view";

/**
 * #790 R1 (#791) - route B: observe the workspace through the sandbox's own file API.
 *
 * Route B was chosen over exposing a port and running code-server in the sandbox, because that would have handed the
 * operator a shell - contradicting AC2, which requires the view to grant no write access. Reading through
 * `files.readFile` / `listDirectory` is read-only by construction: there is no write path to reach.
 *
 * These tests replace an earlier set written for the port-exposure design. That design is gone (no bind, no exposure
 * URL), so its tests are gone with it rather than left passing over dead code.
 *
 * The two properties that must hold before anything is served:
 *
 *   AC2 - read-only by construction. Asserted by driving the reader with a handle whose WRITE and EXEC methods throw,
 *         so an implementation that reaches for one fails loudly instead of quietly.
 *   AC4 - no credential in the served payload. The vault is write-only (#354, egress substitution) so vault values
 *         never touch the filesystem, but `.env`, `.git-credentials` and key files are exactly what a workspace cloned
 *         from a real repo can contain. The filter is the guard; an assumption that secrets are absent is not.
 */

/** A handle that fails on anything but reading, so a write or exec path cannot pass unnoticed. */
function readOnlyHandle(
  entries: { path: string; type?: string; name?: string }[],
  contents: Record<string, string>,
): WorkspaceReader {
  const thrower = (what: string) => () => {
    throw new Error(`the sandbox view must never call ${what}`);
  };
  return {
    files: {
      listDirectory: async () => entries,
      readFile: async (path: string) => {
        if (!(path in contents)) throw new Error(`not found: ${path}`);
        return contents[path];
      },
      writeFiles: thrower("files.writeFiles"),
    },
    commands: { run: thrower("commands.run") },
  } as unknown as WorkspaceReader;
}

describe("#790 R1 route B - AC4: the view must not serve a credential", () => {
  it("refuses .env and every variant of it", () => {
    // A sandbox clones a real repo, and .env.local is the file this project actually uses.
    for (const p of [".env", ".env.local", ".env.production", "config/.env.test"]) {
      expect(isViewablePath(p), p).toBe(false);
    }
  });

  it("refuses the git credential store", () => {
    expect(isViewablePath(".git-credentials")).toBe(false);
    expect(isViewablePath("nested/.git-credentials")).toBe(false);
  });

  it("refuses git's own internals", () => {
    // Not a secret, but a write-shaped surface (hooks, config) a read-only view has no business exposing.
    expect(isViewablePath(".git/config")).toBe(false);
    expect(isViewablePath(".git/hooks/pre-commit")).toBe(false);
  });

  it("refuses key, certificate and identity files", () => {
    for (const p of ["server.pem", "private.key", "id_rsa", ".ssh/id_ed25519", "cert.crt"]) {
      expect(isViewablePath(p), p).toBe(false);
    }
  });

  it("refuses a path that escapes the workspace", () => {
    // The reader is handed paths from a listing, but a traversal is the one input that could leave the workspace
    // entirely, so it is refused on the way in rather than trusted from the listing.
    for (const p of ["../outside", "a/../../etc/passwd", "..\\windows\\system32"]) {
      expect(isViewablePath(p), p).toBe(false);
    }
  });

  it("CONTROL: an ordinary source file is allowed, so the filter is not a blanket refusal", () => {
    // Without this, a filter implemented as `return false` would pass every test above and serve nothing.
    for (const p of ["src/App.tsx", "README.md", "package.json", "docs/page.md"]) {
      expect(isViewablePath(p), p).toBe(true);
    }
  });
});

describe("#790 R1 route B - AC2: read-only by construction", () => {
  it("lists the workspace without ever calling a write or exec method", async () => {
    // The handle throws on writeFiles and run. If the reader touched either, this fails - which is the assertion AC2
    // rests on, rather than a claim about intent.
    const handle = readOnlyHandle(
      [
        { path: "src", type: "directory", name: "src" },
        { path: "src/App.tsx", type: "file", name: "App.tsx" },
      ],
      { "src/App.tsx": "export default function App() { return null; }" },
    );

    const view = await listViewableEntries({ handle, path: "/workspace" });
    expect(view.length).toBe(2);
  });

  it("omits a denylisted entry from the listing rather than throwing on the whole view", async () => {
    // One secret in the tree must not blind the operator to the rest of the workspace.
    const handle = readOnlyHandle(
      [
        { path: ".env.local", type: "file", name: ".env.local" },
        { path: "src/App.tsx", type: "file", name: "App.tsx" },
      ],
      { ".env.local": "SECRET=canary", "src/App.tsx": "ok" },
    );

    const view = await listViewableEntries({ handle, path: "/workspace" });
    const paths = view.map((e) => e.path);
    expect(paths).toContain("src/App.tsx");
    expect(paths).not.toContain(".env.local");
    expect(JSON.stringify(view)).not.toContain("canary");
  });

  it("CONTROL: the listing is not empty, so the assertions above cannot pass vacuously", async () => {
    const handle = readOnlyHandle([{ path: "src/App.tsx", type: "file", name: "App.tsx" }], { "src/App.tsx": "ok" });
    expect((await listViewableEntries({ handle, path: "/workspace" })).length).toBeGreaterThan(0);
  });
});
