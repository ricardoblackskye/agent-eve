import { join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";
import {
  gitAuthEnv,
  planCheckout,
  planProvisioning,
} from "../../agent/lib/dark-factory/local-run-checkout";

/**
 * #404 R1 Task 3 - the working directory is a checklist item, and it never carries a credential.
 *
 * Two things this has to get right, both learned the hard way:
 *
 * 1. `process.cwd()` is what discovery reads (#405), so the child must run in a checkout of the TARGET repo. My
 *    first live run scanned agent-eve while the story was about WebFeedPOC.
 * 2. A clone with a credential in its URL persists that credential in `.git/config` — I found my own token in a
 *    scratch checkout's config. The URL must be clean; auth belongs in the environment of one git invocation.
 */
const SECRET = "ghp_THIS-MUST-NEVER-APPEAR-2222222222";
// path.join normalises to the platform separator, so the expected root must too - the planner builds its path
// with path.join, and a forward-slash literal here would make a startsWith check false on Windows for no real reason.
const ROOT = pathJoin("C:/Users/tester/df-workspaces");

const plan = (over: Partial<Parameters<typeof planCheckout>[0]> = {}) =>
  planCheckout({
    repo: "ricardoblackskye/WebFeedPOC",
    workspaceRoot: ROOT,
    exists: () => false,
    issue: 169,
    ...over,
  });

describe("#404 R1 Task 3 - checkout planning", () => {
  it("targets a per-issue workspace for the TARGET repository", () => {
    const planned = plan();

    expect(planned.path.toLowerCase()).toContain("webfeedpoc");
    expect(planned.path).toContain("169");
    expect(planned.path.startsWith(ROOT)).toBe(true);
  });

  it("clones when the workspace is absent, and reuses it when present", () => {
    expect(plan().mustClone).toBe(true);
    expect(plan().cloneArgs.length).toBeGreaterThan(0);

    const present = plan({ exists: () => true });
    expect(present.mustClone).toBe(false);
    expect(present.cloneArgs).toEqual([]);
  });

  it("puts NO credential in the clone argv, and the clean URL in its place", () => {
    const argv = plan().cloneArgs.join(" ");

    expect(argv).toContain("https://github.com/ricardoblackskye/WebFeedPOC.git");
    expect(argv).not.toContain("x-access-token");
    expect(argv).not.toContain(SECRET);
    expect(argv).not.toContain("@github.com");
  });

  it("renders a summary that is safe to print", () => {
    const planned = plan();

    expect(planned.summary).toContain("WebFeedPOC");
    expect(planned.summary).not.toContain(SECRET);
    expect(planned.summary).not.toContain("ghp_");
  });

  it("keeps the workspace inside the root even for a hostile repository name", () => {
    const planned = plan({ repo: "owner/../../escape" });

    expect(planned.path.startsWith(ROOT)).toBe(true);
    expect(planned.path).not.toContain("..");
  });

  it("authenticates through the environment, never through the URL", () => {
    const env = gitAuthEnv(SECRET);

    expect(Object.keys(env).some((key) => key.startsWith("GIT_CONFIG"))).toBe(true);
    const joined = Object.values(env).join(" ");
    expect(joined).toContain("Authorization");
    // The credential is present in the ENVIRONMENT (that is the point) but never inside a URL.
    expect(joined).not.toMatch(/https:\/\/[^\s"]*@github\.com/);
  });

  it("composes so that one git invocation is authenticated while argv stays clean", () => {
    const planned = plan();
    const env = gitAuthEnv(SECRET);

    expect(planned.cloneArgs.join(" ")).not.toContain(SECRET);
    expect(planned.path).not.toContain(SECRET);
    expect(JSON.stringify(env)).toContain("Authorization");
  });
});


describe("#541 - provisioning is decided AFTER the clone, from the real checkout", () => {
  const WS = pathJoin(ROOT, "webfeedpoc-169");
  const lockfile = pathJoin(WS, "package-lock.json");
  const manifest = pathJoin(WS, "package.json");
  /** The planner asks about paths, so a set answers it the way a filesystem would. */
  const seeing = (...paths: string[]) => (candidate: string) => paths.includes(candidate);

  it("does NOT guess a provisioning command before the clone", () => {
    // A pre-clone decision answers NO for every repository, because a fresh workspace has no files yet. The plan
    // must therefore carry no guess: this is the defect the live run exposed.
    expect("installArgs" in plan()).toBe(false);
  });

  it("provisions with npm ci when the CLONED checkout carries a lockfile", () => {
    expect(planProvisioning({ path: WS, exists: seeing(lockfile) }).installArgs).toEqual(["ci"]);
  });

  it("falls back to npm install when the cloned checkout has a manifest and no lockfile", () => {
    expect(planProvisioning({ path: WS, exists: seeing(manifest) }).installArgs).toEqual(["install"]);
  });

  it("runs NO install when the cloned checkout is not a Node project at all", () => {
    // Fail safe: `npm ci` in a repository that was never a Node project would fail the run for an unrelated reason.
    expect(planProvisioning({ path: WS, exists: seeing() }).installArgs).toEqual([]);
  });

  it("names the provisioning in a summary that is safe to print", () => {
    const summary = planProvisioning({ path: WS, exists: seeing(lockfile) }).summary;

    expect(summary).toContain("npm ci");
    expect(summary).not.toContain(SECRET);
  });
});
