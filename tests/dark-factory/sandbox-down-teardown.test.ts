/**
 * #553 AC5 — scripted teardown that releases the sandbox but leaves the cluster standing.
 *
 * The behaviour this pins: there was no scripted teardown at all. `df:sandbox-clean` only
 * deleted leftover BatchSandboxes and pods; nothing uninstalled the release, removed the two
 * namespaces, or released the forwarded port. So a re-run on the same machine inherited
 * whatever the previous run left behind, and the port could still be held by a dangling
 * port-forward from a failed run.
 *
 * The deliberate design decision (agreed on review): teardown is SURGICAL. It leaves minikube
 * running so the next `df:sandbox-up` is a warm `helm upgrade --install` rather than a cold
 * 4-CPU cluster start. A full reset is available, but only as an explicit opt-in flag —
 * destroying the cluster by default would make every re-run pay the cold-start cost.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCRIPT_PATH = resolve(ROOT, "scripts/df-sandbox-down.sh");
const SCRIPT = existsSync(SCRIPT_PATH) ? readFileSync(SCRIPT_PATH, "utf8") : "";
const PKG = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("df:sandbox-down releases the sandbox but leaves the cluster (#553 AC5)", () => {
  it("exists and is wired into package.json", () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
    expect(PKG.scripts["df:sandbox-down"]).toContain("df-sandbox-down.sh");
  });

  it("uninstalls the release rather than only deleting leftovers", () => {
    // The release is what owns the control plane; deleting pods alone leaves the release in a
    // failed state and the next upgrade trips over it.
    expect(SCRIPT).toMatch(/helm[^\n]*uninstall/);
    expect(SCRIPT).toContain("opensandbox");
  });

  it("deletes both namespaces the deploy creates", () => {
    expect(SCRIPT).toContain("opensandbox-system");
    expect(SCRIPT).toContain("opensandbox");
    expect(SCRIPT).toMatch(/kubectl[^\n]*delete\s+namespace/i);
  });

  it("fails when the forwarded port is still listening", () => {
    // A dangling port-forward survives the command and holds the port; silence here is how a
    // later run fails with "address already in use" and no clue why.
    expect(SCRIPT).toMatch(/netstat|Get-NetTCPConnection|lsof/);
    expect(SCRIPT).toMatch(/ERROR[^\n]*port/i);
  });

  it("leaves minikube running by default, and only deletes it on an explicit flag", () => {
    // Surgical by default: the cluster stays up so re-runs are warm.
    expect(SCRIPT).toMatch(/delete-cluster|DELETE_CLUSTER/);
    // Any cluster deletion must sit behind that flag, never run unconditionally. The script
    // resolves minikube from PATH first, so the invocation is "$MINIKUBE" delete rather than
    // the literal `minikube delete` - matching only the literal would have failed on a correct
    // script and passed on one that hardcoded the binary.
    const guarded =
      /if[\s\S]{0,200}(delete-cluster|DELETE_CLUSTER)[\s\S]{0,500}(minikube|MINIKUBE)"?\s+delete/;
    expect(SCRIPT).toMatch(guarded);
  });
});
