import { describe, expect, it } from "vitest";
import {
  createSandboxProvider,
  SandboxConfigError,
  SUPPORTED_SANDBOX_DRIVERS,
} from "../../agent/lib/dark-factory/sandbox-provider";

/**
 * #280 T2 — there is deliberately no boolean "enable" flag: a boolean can default open, while a
 * driver NAME cannot.
 *
 * #383 / #620 — an UNCONFIGURED run is now ISOLATED by default. An unset/blank DF_SANDBOX_DRIVER
 * resolves to opensandbox (see sandbox-provider.ts). The host tree still requires an explicit
 * `DF_SANDBOX_DRIVER=local` to opt out; an unknown value still refuses (naming the supported values).
 */
describe("#383 the host tree requires an explicit flag (unconfigured run is isolated by default)", () => {
  it("isolates by default when DF_SANDBOX_DRIVER is unset", () => {
    const provider = createSandboxProvider({});
    expect(provider.driver).toBe("opensandbox");
    expect(provider.isolated).toBe(true);
  });

  it("isolates by default on an empty or whitespace value", () => {
    const empty = createSandboxProvider({ DF_SANDBOX_DRIVER: "" });
    expect(empty.driver).toBe("opensandbox");
    expect(empty.isolated).toBe(true);
    const ws = createSandboxProvider({ DF_SANDBOX_DRIVER: "   " });
    expect(ws.driver).toBe("opensandbox");
    expect(ws.isolated).toBe(true);
  });

  it("host tree still requires an explicit flag (local selects the host)", () => {
    const provider = createSandboxProvider({ DF_SANDBOX_DRIVER: "local" });
    expect(provider.driver).toBe("local");
    expect(provider.isolated).toBe(false);
  });
});

describe("#280 createSandboxProvider", () => {

  it("selects local explicitly", () => {
    expect(createSandboxProvider({ DF_SANDBOX_DRIVER: "local" }).driver).toBe("local");
  });

  it("selects dry-run, which reports it is NOT isolated", () => {
    const provider = createSandboxProvider({ DF_SANDBOX_DRIVER: "dry-run" });
    expect(provider.driver).toBe("dry-run");
    expect(provider.isolated).toBe(false);
  });

  it("resolves the live sandbox arm without creating anything (creation is lazy)", () => {
    const provider = createSandboxProvider({ DF_SANDBOX_DRIVER: "opensandbox" });
    expect(provider.driver).toBe("opensandbox");
    expect(provider.isolated).toBe(true);
  });

  it("throws on an unknown driver, naming the supported values", () => {
    expect(() => createSandboxProvider({ DF_SANDBOX_DRIVER: "remote-sandbox" })).toThrow(
      /Supported values: local, dry-run/,
    );
  });

  it("offers only the documented drivers (no boolean that could default open)", () => {
    // #281 T4 adds the live sandbox arm; this assertion is the guard on the SET.
    expect([...SUPPORTED_SANDBOX_DRIVERS]).toEqual(["local", "dry-run", "opensandbox"]);
  });
});

/**
 * #282 (R3) — the vault gate is FAIL-CLOSED.
 *
 * Vault-backed wiring needs a vault-capable execution backend. Asking for the gate while the driver
 * cannot honour it must refuse the run with an explicit error, never silently fall back to a
 * host-side push (a silent fallback is how an operator believes a secret is contained while it is
 * not).
 */
describe("#282 R3 vault gate is fail-closed", () => {
  it("accepts the gate on the vault-capable opensandbox driver", () => {
    const provider = createSandboxProvider({
      DF_SANDBOX_DRIVER: "opensandbox",
      DF_SANDBOX_VAULT_ENABLED: "1",
    });
    expect(provider.driver).toBe("opensandbox");
  });

  it("refuses when the gate is set but the driver cannot honour it", () => {
    expect(() =>
      createSandboxProvider({
        DF_SANDBOX_DRIVER: "local",
        DF_SANDBOX_VAULT_ENABLED: "1",
      }),
    ).toThrow(SandboxConfigError);
  });

  it("resolves to opensandbox when the gate is set with no explicit driver (default isolation satisfies the gate)", () => {
    const provider = createSandboxProvider({ DF_SANDBOX_VAULT_ENABLED: "1" });
    expect(provider.driver).toBe("opensandbox");
  });

  it("treats a blank gate value as off (no accidental refusal)", () => {
    expect(
      createSandboxProvider({ DF_SANDBOX_DRIVER: "local", DF_SANDBOX_VAULT_ENABLED: "   " })
        .driver,
    ).toBe("local");
  });
});
