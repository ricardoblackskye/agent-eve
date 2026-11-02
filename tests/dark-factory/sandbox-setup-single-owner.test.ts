/**
 * #570 — the local sandbox setup must leave chart-owned objects to Helm.
 *
 * The failure this pins: `bootstrap.sh` patched the ConfigMap the chart creates with
 * `kubectl create ConfigMap ... | kubectl apply -f -`, so the object ended up with two
 * managers (`helm <- Apply`, `kubectl-client-side-apply <- Update`). The next
 * `helm upgrade` then aborts with `Apply failed with 1 conflict: ... .data.config.toml`,
 * leaving the release STATUS `failed` while the control plane never becomes ready.
 *
 * Reproduced on record before this test was written: both runs exited 1, revision 5 -> 6
 * each failing, and the two managers above read straight off the object.
 *
 * A cluster cannot live in CI, so the runtime proof stays a manual two-run check. What
 * this file pins is the CAUSE, statically: chart-owned objects are not mutated by kubectl,
 * and the proven config and env arrive through Helm values instead.
 *
 * The last two cases are controls. Without them the suite would pass for a script that
 * never talks to Helm at all, or one that stopped applying the CRDs the chart omits.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(
  resolve(process.cwd(), "scripts/k8s-vault-proof/bootstrap.sh"),
  "utf8",
);

describe("the sandbox setup leaves chart-owned objects to Helm (#570)", () => {
  it("does not kubectl-apply the ConfigMap the chart creates", () => {
    // The chart's own template creates opensandbox-server-config from .Values.configToml.
    expect(SCRIPT).not.toMatch(/create\s+ConfigMap\s+opensandbox-server-config/);
  });

  it("does not hand a config file to kubectl, in any spelling", () => {
    // Mechanism, not line shape: the mutation is ONE long line, so the line-scoped
    // version of this test missed it and passed falsely.
    expect(SCRIPT).not.toMatch(/from-file=[^\n]*config\.toml/);
    // APPLYING or CREATING it is the co-ownership bug. DELETING it is the repair, and is
    // required: a stale field manager cannot be edited away, so the object must be deleted
    // and let Helm recreate it. This assertion failed on the repair line until it was
    // scoped to the mutation verbs - the guard catching its own fix.
    expect(SCRIPT).not.toMatch(/kubectl[^\n]*(apply|create)[^\n]*opensandbox-server-config/);
    // Case-insensitive so the pattern body reads cleanly while still matching the script's
    // lowercase delete form - reworded text and matching text are different jobs.
    expect(SCRIPT).toMatch(/kubectl[^\n]*delete\s+ConfigMap\s+opensandbox-server-config/i);
  });

  it("converts repo paths for the native tools, which cannot read MSYS paths", () => {
    // helm and kubectl are native Windows binaries; /c/Users/... means nothing to them, so
    // both a --set-file and a kubectl apply -f died on it.
    expect(SCRIPT).toContain("REPO_NATIVE");
    expect(SCRIPT).toContain("cygpath -m");
    expect(SCRIPT).toMatch(/kubectl\s+apply\s+-f\s+"\$REPO_NATIVE/);
  });

  it("does not kubectl-set-env the server Deployment the chart owns", () => {
    expect(SCRIPT).not.toMatch(/kubectl[^\n]*set\s+env[^\n]*opensandbox-server/);
  });

  it("passes the proven config through the chart's configToml value", () => {
    // The chart mounts .Values.configToml at /etc/opensandbox/config.toml.
    expect(SCRIPT).toContain("configToml");
    expect(SCRIPT).toContain("sandbox_create_timeout_seconds = 300");
  });

  it("passes the server env through the chart's env value, not kubectl", () => {
    expect(SCRIPT).toContain("opensandbox-server.server.env");
    // helm sets name and value as separate flags, so the joined literal never appears -
    // asserting it was wrong, not the script.
    expect(SCRIPT).toContain("server.env[0].name=OPENSANDBOX_INSECURE_SERVER");
    expect(SCRIPT).toContain("server.env[0].value=YES");
    expect(SCRIPT).toContain("server.env[1].name=OPENSANDBOX_CONFIG");
    expect(SCRIPT).toContain("server.env[1].value=/etc/opensandbox/config.toml");
  });

  it("CONTROL: still installs the chart with Helm", () => {
    // The script invokes "$HELM", not the literal `helm`. The first version of this
    // control asserted the literal and so failed against a script doing it correctly.
    expect(SCRIPT).toMatch(/upgrade\s+--install\s+opensandbox/);
    expect(SCRIPT).toMatch(/^\s*HELM=/m);
  });

  it("creates the sandbox workload namespace, which the chart does not", () => {
    // Found only by a cold start: the config named NS_SB, the chart creates only the
    // control-plane namespace, and the server refused every sandbox with
    // "Create sandbox failed: Namespace not found: (404)". On a long-lived cluster the
    // namespace already existed, so nothing failed and nothing was noticed.
    expect(SCRIPT).toMatch(/kubectl\s+create\s+namespace\s+"\$NS_SB"/);
  });

  it("CONTROL: still applies the CRDs the base chart omits", () => {
    // Pool and SandboxSnapshot are absent from the base chart; the controller crashloops
    // without them. Cluster-scoped and not Helm-owned, so they stay a kubectl apply.
    expect(SCRIPT).toContain("sandbox.opensandbox.io_");
    expect(SCRIPT).toMatch(/for\s+crd\s+in\s+pools\s+sandbox/);
  });
});
