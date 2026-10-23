import { describe, it, expect } from "vitest";
import {
  resolvePlanWorkspace,
  resolveWorkspaceOverride,
} from "../agent/lib/dark-factory/plan-workspace";

const TARGET = "ricardoblackskye/WebFeedPOC";

/** A remote lookup over a fixed map, so the gate is tested with no filesystem. */
function remotes(map: Record<string, string | null>) {
  return (dir: string) => map[dir] ?? null;
}

describe("plan workspace gate (issue #405)", () => {
  it("accepts a checkout whose origin is the target (https, with .git)", () => {
    const r = resolvePlanWorkspace({
      targetRepo: TARGET,
      cwd: "/w/webfeedpoc-172",
      remoteOf: remotes({ "/w/webfeedpoc-172": "https://github.com/ricardoblackskye/WebFeedPOC.git" }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe("/w/webfeedpoc-172");
      expect(r.source).toBe("cwd");
    }
  });

  it("accepts the ssh form of the same remote", () => {
    const r = resolvePlanWorkspace({
      targetRepo: TARGET,
      cwd: "/w/x",
      remoteOf: remotes({ "/w/x": "git@github.com:ricardoblackskye/WebFeedPOC.git" }),
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a remote without .git and ignores case", () => {
    const r = resolvePlanWorkspace({
      targetRepo: TARGET,
      cwd: "/w/x",
      remoteOf: remotes({ "/w/x": "https://github.com/RicardoBlackskye/webfeedpoc" }),
    });
    expect(r.ok).toBe(true);
  });

  it("tolerates a trailing slash on the remote", () => {
    const r = resolvePlanWorkspace({
      targetRepo: TARGET,
      cwd: "/w/x",
      remoteOf: remotes({ "/w/x": "https://github.com/ricardoblackskye/WebFeedPOC/" }),
    });
    expect(r.ok).toBe(true);
  });

  it("REFUSES a checkout of a different repository, naming both", () => {
    const r = resolvePlanWorkspace({
      targetRepo: TARGET,
      cwd: "/dev/agent-eve",
      remoteOf: remotes({ "/dev/agent-eve": "https://github.com/ricardoblackskye/agent-eve.git" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = r.problems.join("\n");
      expect(text).toContain(TARGET);
      expect(text).toContain("ricardoblackskye/agent-eve");
      expect(text).toContain("/dev/agent-eve");
    }
  });

  it("REFUSES a directory that is not a checkout at all", () => {
    const r = resolvePlanWorkspace({
      targetRepo: TARGET,
      cwd: "/not/a/repo",
      remoteOf: remotes({}),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.join("\n")).toMatch(/not a git checkout|no origin/i);
    }
  });

  it("accepts an override that points at the target and reports it as the source", () => {
    const r = resolvePlanWorkspace({
      targetRepo: TARGET,
      cwd: "/dev/agent-eve",
      override: "/w/webfeedpoc-172",
      remoteOf: remotes({
        "/dev/agent-eve": "https://github.com/ricardoblackskye/agent-eve.git",
        "/w/webfeedpoc-172": "https://github.com/ricardoblackskye/WebFeedPOC.git",
      }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe("/w/webfeedpoc-172");
      expect(r.source).toBe("override");
    }
  });

  it("still REFUSES when the override itself is the wrong repository", () => {
    const r = resolvePlanWorkspace({
      targetRepo: TARGET,
      cwd: "/w/webfeedpoc-172",
      override: "/dev/agent-eve",
      remoteOf: remotes({
        "/dev/agent-eve": "https://github.com/ricardoblackskye/agent-eve.git",
        "/w/webfeedpoc-172": "https://github.com/ricardoblackskye/WebFeedPOC.git",
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.join("\n")).toContain("ricardoblackskye/agent-eve");
    }
  });
});

describe("workspace override resolution (issue #405)", () => {
  const none: Record<string, string | undefined> = {};

  it("is undefined when nothing supplies one", () => {
    expect(resolveWorkspaceOverride(["node", "runner.ts"], none)).toBeUndefined();
  });

  it("reads --workspace <dir>", () => {
    expect(resolveWorkspaceOverride(["--workspace", "/w/x"], none)).toBe("/w/x");
  });

  it("reads --workspace=<dir>", () => {
    expect(resolveWorkspaceOverride(["--workspace=/w/x"], none)).toBe("/w/x");
  });

  it("reads DF_PLAN_WORKSPACE", () => {
    expect(resolveWorkspaceOverride([], { DF_PLAN_WORKSPACE: "/w/env" })).toBe("/w/env");
  });

  it("prefers the argument over the environment", () => {
    expect(
      resolveWorkspaceOverride(["--workspace", "/w/arg"], { DF_PLAN_WORKSPACE: "/w/env" }),
    ).toBe("/w/arg");
  });

  it("ignores a blank value rather than treating it as a choice", () => {
    expect(resolveWorkspaceOverride([], { DF_PLAN_WORKSPACE: "   " })).toBeUndefined();
  });
});
