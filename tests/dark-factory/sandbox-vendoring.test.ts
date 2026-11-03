/**
 * #553 AC2 — the sandbox chart and images are VENDORED, not fetched at run time.
 *
 * The defect this pins: `bootstrap.sh` did `git clone --depth 1 .../OpenSandbox.git` and
 * downloaded the helm binary from get.helm.sh on every cold run, then pulled images from
 * `sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/...:release-1.1.1` — a floating tag. So a
 * "reproducible" local sandbox depended on GitHub, get.helm.sh and a Chinese registry being
 * reachable at install time, and could silently install different bits than the last run.
 *
 * What this file pins, statically (no cluster in CI):
 *   - the umbrella chart is committed in-tree and every subchart dependency resolves by
 *     `file://`, so `helm dependency build` never reaches the network;
 *   - a committed lock names the local chart path and the image digests;
 *   - the image references in the lock agree with the ones the server config actually uses,
 *     so the lock cannot drift away from the deploy;
 *   - image blobs are NOT committed: the cache directory is gitignored.
 *
 * Assertions are raw-text on purpose: this repo has no YAML parser dependency and its
 * existing guards (`sandbox-setup-single-owner.test.ts`, `doc-drift-guards.test.ts`) read
 * files as text. Parsing here would add a dependency to prove a static fact.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const LOCK_PATH = resolve(ROOT, "scripts/sandbox-vendor/artifacts.lock.json");
const BOOTSTRAP = resolve(ROOT, "scripts/k8s-vault-proof/bootstrap.sh");
const GITIGNORE = resolve(ROOT, ".gitignore");

interface LockImage {
  ref: string;
  digest: string;
}
interface Lock {
  chart: { path: string; version: string; source: string };
  images: LockImage[];
  crds: { path: string };
}

function readLock(): Lock {
  return JSON.parse(readFileSync(LOCK_PATH, "utf8")) as Lock;
}

describe("the sandbox chart and images are vendored (#553 AC2)", () => {
  it("commits a lock naming a LOCAL chart path, never a git URL", () => {
    expect(existsSync(LOCK_PATH)).toBe(true);
    const lock = readLock();
    // The whole point of AC2: the chart lives in the checkout. A URL here means a run-time fetch.
    expect(lock.chart.path).toBe("vendor/opensandbox-charts/opensandbox");
    expect(lock.chart.path).not.toMatch(/^https?:\/\/|^git@|\.git$/);
    expect(lock.chart.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("commits the chart itself, so the lock path is not a dangling promise", () => {
    const lock = readLock();
    const chartDir = resolve(ROOT, lock.chart.path);
    expect(existsSync(resolve(chartDir, "Chart.yaml"))).toBe(true);
    // The umbrella chart's subcharts live as siblings; the deploy needs them all present.
    for (const sub of [
      "base",
      "controller",
      "server",
      "ingress-gateway",
      "node-agent",
      "fast-sandbox",
    ]) {
      expect(existsSync(resolve(chartDir, "..", sub, "Chart.yaml"))).toBe(true);
    }
  });

  it("resolves every subchart dependency by file:// so helm never hits the network", () => {
    const lock = readLock();
    const chartYaml = readFileSync(resolve(ROOT, lock.chart.path, "Chart.yaml"), "utf8");
    // Every `repository:` line under dependencies must be a local file:// path.
    const repositories = [...chartYaml.matchAll(/^\s*repository:\s*(.+)$/gm)].map((m) =>
      m[1].trim().replace(/^["']|["']$/g, ""),
    );
    expect(repositories.length).toBeGreaterThan(0);
    for (const repository of repositories) {
      expect(repository).toMatch(/^file:\/\//);
      expect(repository).not.toMatch(/^https?:\/\//);
    }
  });

  it("pins every image by sha256 digest rather than a floating tag", () => {
    const lock = readLock();
    expect(lock.images.length).toBeGreaterThan(0);
    for (const image of lock.images) {
      expect(image.ref).toMatch(/:[^/:]+$/);
      expect(image.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("keeps the lock's images in step with the images the server config deploys", () => {
    const lock = readLock();
    const script = readFileSync(BOOTSTRAP, "utf8");
    // Guard against a lock describing images nobody runs: each locked ref must appear in the
    // deploy config bootstrap writes.
    for (const image of lock.images) {
      expect(script).toContain(image.ref);
    }
  });

  it("does not commit image blobs: the vendor cache is gitignored", () => {
    expect(readFileSync(GITIGNORE, "utf8")).toMatch(/scripts\/sandbox-vendor\/cache/);
  });
});
