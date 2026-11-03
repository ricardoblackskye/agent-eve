/**
 * #553 AC1/AC2/AC4 — bootstrap.sh must resolve its inputs instead of fetching them, and
 * accept a cluster parameter.
 *
 * The defect this pins: the script did `git clone --depth 1 .../OpenSandbox.git`, downloaded
 * helm from get.helm.sh via curl, and pulled images by floating tag on every cold run. So a
 * "reproducible" local sandbox needed GitHub, get.helm.sh and a Chinese registry reachable at
 * install time. It also hardcoded `minikube start`, so the same script could not target a
 * remote cluster.
 *
 * A cluster cannot live in CI, so what this pins is the CONTRACT, statically: no run-time
 * fetch, PATH-first binary resolution with env overrides, an honoured KUBE_CONTEXT, and a
 * refusal that names the offending image. The runtime proof stays a manual run.
 *
 * The #570 invariants (Helm is the single owner of chart objects) must keep passing — that
 * suite is the control proving this change did not undo the earlier repair.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(
  resolve(process.cwd(), "scripts/k8s-vault-proof/bootstrap.sh"),
  "utf8",
);

describe("bootstrap.sh resolves its inputs instead of fetching them (#553 AC2)", () => {
  it("never clones the chart or downloads helm at run time", () => {
    // Both were run-time network dependencies; the chart is committed and helm is resolved.
    expect(SCRIPT).not.toMatch(/git\s+clone/);
    expect(SCRIPT).not.toMatch(/\bcurl\b/);
    expect(SCRIPT).not.toMatch(/get\.helm\.sh/);
  });

  it("points at the committed chart and CRDs", () => {
    expect(SCRIPT).toContain("vendor/opensandbox-charts/opensandbox");
    expect(SCRIPT).toContain("vendor/opensandbox-crds");
  });

  it("resolves minikube and helm from PATH before any env override", () => {
    // PATH-first is what makes "one command from a checkout" true on a normal machine.
    expect(SCRIPT).toMatch(/command\s+-v\s+minikube/);
    expect(SCRIPT).toMatch(/command\s+-v\s+helm/);
  });

  it("honours KUBE_CONTEXT so one parameter targets a remote cluster (AC4)", () => {
    expect(SCRIPT).toContain("KUBE_CONTEXT");
    expect(SCRIPT).toMatch(/--kube-context/);
    // The hardcoded start must be conditional, not unconditional.
    expect(SCRIPT).toMatch(/if[^\n]*KUBE_CONTEXT|KUBE_CONTEXT[^\n]*then|"\$KUBE_CONTEXT"/);
  });

  it("refuses when an image is absent from the local store, naming it (AC6)", () => {
    expect(SCRIPT).toContain("docker image inspect");
    // The refusal must carry the image reference into the message.
    expect(SCRIPT).toMatch(/ERROR[^\n]*\$[A-Z_]*IMAGE|ERROR[^\n]*\$\{?[A-Z_]*IMAGE/);
  });

  it("refuses when the image cache is empty and names the vendor command", () => {
    expect(SCRIPT).toContain("df:sandbox-vendor");
  });

  it("keeps the #570 invariants: Helm owns the chart objects", () => {
    // Control: these assertions are also in sandbox-setup-single-owner.test.ts. Repeated here
    // so a change that satisfies the ACs by gutting the deploy fails this suite too.
    expect(SCRIPT).toContain("REPO_NATIVE");
    expect(SCRIPT).toContain("cygpath -m");
    expect(SCRIPT).toContain("configToml");
    expect(SCRIPT).toContain("sandbox_create_timeout_seconds = 300");
    expect(SCRIPT).toContain("opensandbox-server.server.env");
    expect(SCRIPT).not.toMatch(/kubectl[^\n]*(apply|create)[^\n]*opensandbox-server-config/);
    expect(SCRIPT).toMatch(/kubectl[^\n]*delete\s+ConfigMap\s+opensandbox-server-config/i);
  });
});
