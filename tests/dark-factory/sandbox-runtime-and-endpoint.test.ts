/**
 * #570 — one runtime, one endpoint, and a smoke that can fail on the vault.
 *
 * The state this pins out of existence: `npm run df:sandbox-up` started
 * `scripts/sandbox-server-up.sh`, which runs the `uvx opensandbox-server` DOCKER runtime on
 * :8080. That runtime hard-rejects `secure_access` and never serves `/credential-vault`, so
 * it cannot do what the Dark Factory's credential path needs - while the local-runs page
 * told you to run it and then pointed `DF_SANDBOX_ENDPOINT` at a CLUSTER port-forward on
 * :18082. The document named one runtime and configured another.
 *
 * Meanwhile `scripts/sandbox-smoke.ts` created a sandbox with a raised timeout and exited 1
 * on failure, but never touched the vault: reachability only. A sandbox that starts and
 * answers /health is not evidence it can inject a credential.
 *
 * AC4 wants one runtime and one endpoint that agree; AC5 wants a smoke that can actually
 * fail when the vault is unavailable; AC7 wants the Docker runtime either gone from the
 * supported path or explicitly documented as non-vault.
 *
 * Static, like the single-owner guard: this needs no cluster, and the runtime proof stays a
 * manual check. The last two cases are controls, so the suite cannot pass by deleting the
 * setup entirely.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
const SMOKE = read("scripts/sandbox-smoke.ts");

describe("the local sandbox has one runtime and one endpoint (#570)", () => {
  it("points df:sandbox-up at the Kubernetes bootstrap, not the Docker server", () => {
    // The Docker runtime cannot serve the vault; the bootstrap can and is the proven path.
    expect(pkg.scripts["df:sandbox-up"]).toMatch(/k8s-vault-proof\/bootstrap\.sh/);
    expect(pkg.scripts["df:sandbox-up"]).not.toMatch(/sandbox-server-up\.sh/);
  });

  it("documents the Docker runtime's limitation, since it is still shipped", () => {
    // Wrong artefact on the first attempt: the npm script does not contain `uvx`, the shell
    // script it runs does - so asserting on df:sandbox-up passed falsely. AC7 says that if
    // the Docker runtime stays for non-vault use, the code must say so explicitly.
    const dockerServer = read("scripts/sandbox-server-up.sh");
    expect(dockerServer).toMatch(/cannot serve the vault|does not serve the vault|non-vault/i);
  });

  it("uses the port the bootstrap actually forwards", () => {
    // The bootstrap forwards 18082; the smoke defaulted to 8080, the port of the runtime we
    // no longer use. One endpoint, taken from the same idea of the setup.
    expect(SMOKE).toMatch(/18082/);
    expect(SMOKE).not.toMatch(/127\.0\.0\.1:8080/);
  });

  it("makes the vault substitution the smoke's assertion, not just reachability", () => {
    // A reachable-but-incapable server must not pass.
    expect(SMOKE).toMatch(/credential[_-]?vault|vault-proof|substitution/i);
  });

  it("CONTROL: the proven bootstrap still exists", () => {
    expect(read("scripts/k8s-vault-proof/bootstrap.sh")).toMatch(/minikube/);
  });

  it("CONTROL: df:sandbox-smoke still exists and runs a script", () => {
    expect(pkg.scripts["df:sandbox-smoke"]).toMatch(/sandbox-smoke/);
  });
});
