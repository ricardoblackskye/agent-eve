import { describe, expect, it } from "vitest";
import { sandboxNetworkPolicy } from "../../agent/lib/dark-factory/opensandbox-driver";

describe("sandboxNetworkPolicy (R3/T3)", () => {
  it("is deny-by-default and allows only the gateway host when set", () => {
    const p = sandboxNetworkPolicy({
      DF_SANDBOX_EGRESS_GATEWAY_HOST: "gw.internal:3000",
    });
    expect(p.defaultAction).toBe("deny");
    expect(p.egress).toEqual([{ action: "allow", target: "gw.internal:3000" }]);
  });

  it("allows an optional git host and explicit targets, denying everything else", () => {
    const p = sandboxNetworkPolicy({
      DF_SANDBOX_EGRESS_GATEWAY_HOST: "gw.internal:3000",
      DF_SANDBOX_EGRESS_GIT_HOST: "github.com",
      DF_SANDBOX_EGRESS_ALLOW: "npm.registry",
    });
    const targets = p.egress.map((e) => e.target).sort();
    expect(targets).toEqual(
      ["github.com", "gw.internal:3000", "npm.registry"].sort(),
    );
    expect(p.egress.every((e) => e.action === "allow")).toBe(true);
  });

  it("fails closed: no gateway host configured => nothing reachable (no silent provider egress)", () => {
    const p = sandboxNetworkPolicy({});
    expect(p.defaultAction).toBe("deny");
    expect(p.egress).toEqual([]);
  });

  it("ignores blank/whitespace entries in the allow-list", () => {
    const p = sandboxNetworkPolicy({
      DF_SANDBOX_EGRESS_GATEWAY_HOST: "gw",
      DF_SANDBOX_EGRESS_ALLOW: " , a ,, b ",
    });
    const targets = p.egress.map((e) => e.target).sort();
    expect(targets).toEqual(["a", "b", "gw"].sort());
  });
});
